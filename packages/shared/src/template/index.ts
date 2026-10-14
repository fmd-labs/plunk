import {LiquidError, type Template} from 'liquidjs';

import {escapingRenderEngine, renderEngine, SCOPE_ALIAS, TEMPLATE_RENDER_LIMIT_MS, validationEngine} from './engine.js';
import {renderLegacyTemplate} from './legacy.js';
import {preprocessTemplate} from './preprocess.js';

/** A template parsed once and ready to be rendered against many recipients. */
export interface CompiledTemplate {
  /** The original, unpreprocessed template string. */
  readonly source: string;
  /**
   * Whether the source parsed as Liquid. A template that failed to parse still renders
   * — through the legacy placeholder renderer — so sends never break on a bad template.
   */
  readonly valid: boolean;
  render(variables: Record<string, unknown>, options?: RenderOptions): string;
  /**
   * `render` without the fallback for a template Liquid cannot finish within `renderLimitMs`:
   * `undefined` instead, so that the caller can leave the template for a render with a larger
   * budget. A template that does not parse renders with the fallback renderer, as `render` does,
   * since no budget would do better.
   */
  renderWithin(variables: Record<string, unknown>, renderLimitMs: number): string | undefined;
}

export interface CompileOptions {
  /**
   * HTML-escape every output (`{{ value }}`), so a variable can carry text but never markup.
   * `{{ value | raw }}` opts out. For email bodies of projects that escape variables; subjects are
   * plain text and are never escaped.
   */
  escapeHtml?: boolean;
}

export interface RenderOptions {
  /**
   * Time budget of this render, in ms. Defaults to `TEMPLATE_RENDER_LIMIT_MS`. A caller that
   * renders while a request waits can afford far less than a worker.
   */
  renderLimitMs?: number;
}

export interface TemplateValidationResult {
  valid: boolean;
  /** Human-readable description of the first syntax error, if any. */
  error?: string;
  line?: number;
  column?: number;
}

/**
 * Parsed templates are cached so the existing per-email call sites (which pass the same
 * campaign body once per recipient) pay the parse cost once per worker rather than once
 * per send. Bounded on both entry count and template size to keep worker memory flat.
 */
const MAX_CACHE_ENTRIES = 32;
const MAX_CACHEABLE_LENGTH = 200_000;

/** Cap on distinct templates we remember having warned about. */
const MAX_REPORTED_SOURCES = 64;

/**
 * `failedWithinMs` latches render-time failures (a runtime limit hit, e.g. an unbounded
 * loop): the largest budget a render has failed within, 0 if none has. A render with that
 * budget or a smaller one would fail again, so it skips Liquid; one with a larger budget
 * still gets its chance. It lives on the cached parse result rather than in a
 * `compileTemplate` closure because the per-email call sites re-compile the same source for
 * every recipient, so a closure-local flag would reset on each one and every recipient
 * would pay the render budget again.
 */
type ParseResult =
  | {templates: Template[]; failedWithinMs: number; error?: undefined}
  | {templates?: undefined; failedWithinMs?: undefined; error: Error};

/** Keyed by the engine's mode and the source: a parse is tied to the engine that made it. */
const parseCache = new Map<string, ParseResult>();

/** Bounded set of template sources already reported, so a bad template logs once. */
const reportedSources = new Set<string>();

function reportOnce(source: string, stage: string, error: unknown): void {
  if (reportedSources.has(source)) {
    return;
  }

  if (reportedSources.size >= MAX_REPORTED_SOURCES) {
    reportedSources.clear();
  }
  reportedSources.add(source);

  const message = error instanceof Error ? error.message : String(error);
  // console rather than signale: @plunk/shared also runs in the browser (editor preview).
  console.warn(`[TEMPLATE] Failed to ${stage} template, falling back to plain variable substitution: ${message}`);
}

function parse(source: string, escapeHtml: boolean): ParseResult {
  const engine = escapeHtml ? escapingRenderEngine : renderEngine;
  try {
    return {templates: engine.parse(preprocessTemplate(source)), failedWithinMs: 0};
  } catch (error) {
    reportOnce(source, 'parse', error);
    return {error: error instanceof Error ? error : new Error(String(error))};
  }
}

function parseCached(source: string, escapeHtml: boolean): ParseResult {
  const key = `${escapeHtml ? 'e' : 'r'}:${source}`;
  const cached = parseCache.get(key);
  if (cached) {
    // Re-insert to mark as most recently used.
    parseCache.delete(key);
    parseCache.set(key, cached);
    return cached;
  }

  const result = parse(source, escapeHtml);

  if (source.length <= MAX_CACHEABLE_LENGTH) {
    if (parseCache.size >= MAX_CACHE_ENTRIES) {
      const oldest = parseCache.keys().next().value;
      if (oldest !== undefined) {
        parseCache.delete(oldest);
      }
    }
    parseCache.set(key, result);
  }

  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Flatten the render scope.
 *
 * Callers pass contact fields both spread at the top level and nested under `data`.
 * Merging keeps both `{{firstName}}` and `{{data.firstName}}` working, with top-level
 * keys winning — the same precedence the old renderer used. `SCOPE_ALIAS` lets
 * preprocessed lookups reach keys whose names contain spaces.
 */
function buildScope(variables: Record<string, unknown>): Record<string, unknown> {
  const nested = variables.data;
  const scope: Record<string, unknown> = isPlainObject(nested) ? {...nested, ...variables} : {...variables};
  scope[SCOPE_ALIAS] = scope;
  return scope;
}

/**
 * Parse a template once so it can be rendered for many recipients.
 *
 * Never throws: a template that fails to parse falls back to plain `{{variable}}`
 * substitution, and `valid` reports which path it took. Use `validateTemplate` to
 * surface syntax errors to the author.
 */
export function compileTemplate(source: string, {escapeHtml = false}: CompileOptions = {}): CompiledTemplate {
  const parsed = parseCached(source, escapeHtml);

  if (parsed.error) {
    const renderLegacy = (variables: Record<string, unknown>) => renderLegacyTemplate(source, variables, {escapeHtml});
    return {source, valid: false, render: renderLegacy, renderWithin: renderLegacy};
  }

  const engine = escapeHtml ? escapingRenderEngine : renderEngine;
  const renderWithin = (variables: Record<string, unknown>, renderLimitMs: number): string | undefined => {
    // A template that already blew a runtime limit will blow it again for every other
    // recipient, so stop asking. Retrying spends the render budget per contact on a
    // campaign that is going out through the legacy renderer regardless.
    if (renderLimitMs <= parsed.failedWithinMs) {
      return undefined;
    }

    try {
      return String(engine.renderSync(parsed.templates, buildScope(variables), {renderLimit: renderLimitMs}));
    } catch (error) {
      // A render error means a runtime limit was hit (e.g. an unbounded loop).
      parsed.failedWithinMs = renderLimitMs;
      reportOnce(source, 'render', error);
      return undefined;
    }
  };

  return {
    source,
    valid: true,
    render: (variables, {renderLimitMs = TEMPLATE_RENDER_LIMIT_MS} = {}) =>
      renderWithin(variables, renderLimitMs) ?? renderLegacyTemplate(source, variables, {escapeHtml}),
    renderWithin,
  };
}

/**
 * Render an email template.
 *
 * Templates are Liquid, so conditionals, loops and filters are available on top of the
 * `{{variable}}` and `{{variable ?? fallback}}` syntax Plunk has always supported:
 *
 *   renderTemplate('Hello {{name}}!', {name: 'World'})                  -> 'Hello World!'
 *   renderTemplate('Hello {{data.name}}!', {data: {name: 'World'}})     -> 'Hello World!'
 *   renderTemplate('Hello {{name ?? Guest}}!', {})                      -> 'Hello Guest!'
 *   renderTemplate('{% if plan == "pro" %}Pro{% endif %}', {plan: 'pro'}) -> 'Pro'
 *
 * Never throws. For a template rendered against many recipients, prefer
 * `compileTemplate` to hoist the parse out of the loop.
 */
export function renderTemplate(
  template: string,
  variables: Record<string, unknown>,
  options: CompileOptions = {},
): string {
  return compileTemplate(template, options).render(variables);
}

/**
 * Check a template for syntax errors, for use at authoring time.
 *
 * Stricter than rendering: unknown filters are reported here but skipped at send time,
 * so saving a template can flag a typo without ever blocking a send.
 *
 * Positions come from the preprocessed source. Preprocessing never adds or removes
 * newlines, so `line` always matches the author's template; `column` can be off by the
 * length of a rewrite earlier on the same line.
 */
export function validateTemplate(source: string): TemplateValidationResult {
  try {
    validationEngine.parse(preprocessTemplate(source));
    return {valid: true};
  } catch (error) {
    if (LiquidError.is(error)) {
      const [line, column] = error.token.getPosition();
      return {
        valid: false,
        // Liquid appends ", line:N, col:M" to the message; the position is returned
        // separately so callers can format it themselves.
        error: error.message.replace(/, line:\d+, col:\d+$/, ''),
        line,
        column,
      };
    }

    return {valid: false, error: error instanceof Error ? error.message : String(error)};
  }
}

/** Test seam: drop parsed templates and warning state. */
export function clearTemplateCache(): void {
  parseCache.clear();
  reportedSources.clear();
}
