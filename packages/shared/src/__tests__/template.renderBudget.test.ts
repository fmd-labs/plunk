import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {renderEngine, TEMPLATE_RENDER_LIMIT_MS} from '../template/engine.js';
import {clearTemplateCache, compileTemplate} from '../template/index.js';

/**
 * A render can take a smaller budget than the worker's, for a caller that renders while a request
 * waits. A failure within one budget must not send renders with a larger budget to the legacy
 * renderer: the API and the worker render the same templates with different budgets.
 */
describe('compileTemplate render budget', () => {
  beforeEach(() => {
    clearTemplateCache();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Liquid fails any render whose budget is below `needsMs`, as a template that slow would. */
  function engineNeeding(needsMs: number) {
    return vi.spyOn(renderEngine, 'renderSync').mockImplementation((_templates, _scope, options) => {
      if ((options?.renderLimit ?? TEMPLATE_RENDER_LIMIT_MS) < needsMs) {
        throw new Error('template render limit exceeded');
      }
      return 'liquid';
    });
  }

  it('aborts a runaway loop within the budget it is given', () => {
    // Allocates nothing, so only the time budget stops it.
    const loop = '{% for a in (1..100000) %}{% for b in (1..100000) %}{% endfor %}{% endfor %}';
    const template = compileTemplate(`${loop} {{name}}`);

    const start = Date.now();
    const result = template.render({name: 'Ada'}, {renderLimitMs: 20});

    expect(Date.now() - start).toBeLessThan(TEMPLATE_RENDER_LIMIT_MS / 2);
    expect(result).toBe(`${loop} Ada`);
  });

  it('passes the default budget to Liquid when none is given', () => {
    const renderSync = engineNeeding(0);

    compileTemplate('{{name}} default').render({name: 'Ada'});

    expect(renderSync).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      renderLimit: TEMPLATE_RENDER_LIMIT_MS,
    });
  });

  it('skips Liquid for budgets no larger than one that failed, and tries larger ones', () => {
    const renderSync = engineNeeding(200);
    const template = compileTemplate('{{name}} small then large');

    expect(template.render({name: 'Ada'}, {renderLimitMs: 50})).toBe('Ada small then large');
    expect(template.render({name: 'Ada'}, {renderLimitMs: 50})).toBe('Ada small then large');
    expect(template.render({name: 'Ada'}, {renderLimitMs: 20})).toBe('Ada small then large');
    expect(renderSync).toHaveBeenCalledTimes(1);

    expect(template.render({name: 'Ada'})).toBe('liquid');
    expect(renderSync).toHaveBeenCalledTimes(2);
  });

  it('skips Liquid for smaller budgets once the default budget failed', () => {
    const renderSync = engineNeeding(Infinity);
    const template = compileTemplate('{{name}} large then small');

    template.render({name: 'Ada'});
    template.render({name: 'Ada'}, {renderLimitMs: 50});

    expect(renderSync).toHaveBeenCalledTimes(1);
  });

  it('keeps the latch across compiles of a cached source', () => {
    const renderSync = engineNeeding(200);

    compileTemplate('{{name}} cached').render({name: 'Ada'}, {renderLimitMs: 50});
    compileTemplate('{{name}} cached').render({name: 'Ada'}, {renderLimitMs: 50});

    expect(renderSync).toHaveBeenCalledTimes(1);
  });
});
