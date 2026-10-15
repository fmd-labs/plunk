import {Liquid, toValueSync} from 'liquidjs';

/**
 * Tags that resolve a partial by name through the file system. Template bodies are
 * authored by users, so leaving these enabled turns every template into an arbitrary
 * file read on the worker's disk (`{% render '../../.env' %}`). We both remove the
 * file system (`templates: {}` shadows the `root`/`partials`/`layouts` lookups) and
 * replace the tags, so authors get a clear message instead of a confusing ENOENT.
 */
const BLOCKED_TAGS = ['include', 'render', 'layout'] as const;

/**
 * DoS ceilings. Templates are user input and are rendered once per recipient, so a
 * single pathological template must not be able to stall a worker. The limits are far
 * above anything a real email needs — a 60 KB template renders in tens of
 * microseconds, so a 1 s render budget is roughly four orders of magnitude of slack.
 */
export const TEMPLATE_PARSE_LIMIT = 2_000_000;
export const TEMPLATE_RENDER_LIMIT_MS = 1_000;
export const TEMPLATE_MEMORY_LIMIT = 10_000_000;

/**
 * Key under which the render scope references itself. Liquid has no syntax for
 * looking up a top-level key that contains a space, and CSV imports routinely produce
 * them (a "First Name" header becomes the key `first name`). Templates referencing
 * those keys are rewritten to `__plunk["first name"]` during preprocessing.
 */
export const SCOPE_ALIAS = '__plunk';

/**
 * Preserves the pre-Liquid behaviour of outputting a bare array as an HTML list.
 *
 * Liquid joins arrays without a separator, which would silently mangle templates that
 * relied on `{{ items }}` rendering `<li>` elements. Registered as Liquid's
 * `outputEscape` hook, which appends itself to every output's filter chain — so
 * `{{ items | raw }}` opts out and `{% for %}` is unaffected.
 */
function renderArrayAsListItems(value: unknown): string {
  if (!Array.isArray(value)) {
    // Not necessarily a string: Liquid stringifies whatever we hand back, and
    // deferring to it keeps Drops, dates and numbers formatted exactly as usual.
    return value as string;
  }

  return value.map(item => `<li>${item ?? ''}</li>`).join('\n');
}

const HTML_ESCAPES: Record<string, string> = {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'};

/** Escape the five characters that are special in HTML text and attribute values. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, character => HTML_ESCAPES[character]!);
}

const HTML_UNESCAPES: Record<string, string> = Object.fromEntries(
  Object.entries(HTML_ESCAPES).map(([character, entity]) => [entity, character]),
);

/**
 * `escapeHtml` that leaves text escaped already as it is (Liquid's `escape_once`): the five entities
 * are read back first, so a value that passed through `| escape` or a `{% capture %}` is not escaped
 * twice. Markup still never gets through.
 */
export function escapeHtmlOnce(text: string): string {
  return escapeHtml(text.replace(/&(?:amp|lt|gt|quot|#39);/g, entity => HTML_UNESCAPES[entity]!));
}

/** A value as Liquid prints it: nothing for a missing value, otherwise its string form. */
function printed(value: unknown): string {
  const plain = toValueSync(value);
  return plain === null || plain === undefined ? '' : String(plain);
}

/**
 * `renderArrayAsListItems` for bodies whose variables are HTML-escaped: every output is escaped,
 * array items each on their own, so a value can carry text but never markup. `{{ value | raw }}`
 * opts out, as it does from the list rendering.
 */
function renderEscapedOutput(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map(item => `<li>${escapeHtmlOnce(printed(item))}</li>`).join('\n');
  }

  return escapeHtmlOnce(printed(value));
}

/**
 * Tags that write values without the `outputEscape` hook, so an engine that escapes variables does not
 * offer them: `{% echo %}` (and `{% liquid %}`, which can echo) and `{% cycle %}`.
 */
const UNESCAPED_OUTPUT_TAGS = ['echo', 'liquid', 'cycle'] as const;

function createEngine({strictFilters, escapeOutput = false}: {strictFilters: boolean; escapeOutput?: boolean}): Liquid {
  const engine = new Liquid({
    // No file system access whatsoever — see BLOCKED_TAGS.
    templates: {},
    relativeReference: false,
    // JavaScript truthiness. Contact data arrives from CSV imports and API payloads
    // where "key present but blank" is the norm, and Liquid's Shopify-compatible
    // truthiness would make `{% if firstName %}` true for an empty string.
    jsTruthy: true,
    // Contact data is unsanitised user input; never walk its prototype chain.
    ownPropertyOnly: true,
    // An unknown variable renders as an empty string, matching the previous
    // regex-based renderer. Templates are written against per-contact custom fields
    // that legitimately differ from contact to contact, so this can't be strict.
    strictVariables: false,
    strictFilters,
    parseLimit: TEMPLATE_PARSE_LIMIT,
    renderLimit: TEMPLATE_RENDER_LIMIT_MS,
    memoryLimit: TEMPLATE_MEMORY_LIMIT,
    outputEscape: escapeOutput ? renderEscapedOutput : renderArrayAsListItems,
  });

  for (const name of BLOCKED_TAGS) {
    engine.registerTag(name, {
      parse() {
        throw new Error(`The {% ${name} %} tag is not available in Plunk templates`);
      },
      render() {
        return '';
      },
    });
  }

  if (escapeOutput) {
    for (const name of UNESCAPED_OUTPUT_TAGS) {
      engine.registerTag(name, {
        parse() {
          throw new Error(`The {% ${name} %} tag is not available when variables are escaped; use {{ }}`);
        },
        render() {
          return '';
        },
      });
    }
  }

  return engine;
}

/** Engine used for every send. Lenient: unknown filters and variables are skipped. */
export const renderEngine = createEngine({strictFilters: false});

/**
 * `renderEngine` with every output HTML-escaped, for email bodies of projects that escape
 * variables. Liquid applies the escape when it parses a template, so a template parsed by one
 * engine cannot be rendered by the other.
 */
export const escapingRenderEngine = createEngine({strictFilters: false, escapeOutput: true});

/**
 * Engine used by `validateTemplate` at authoring time. Identical except that unknown
 * filters raise, so a typo like `{{ name | upcse }}` is reported while the author is
 * still editing rather than silently dropping the value from every email.
 */
export const validationEngine = createEngine({strictFilters: true});
