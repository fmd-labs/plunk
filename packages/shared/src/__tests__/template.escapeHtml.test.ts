import {afterEach, describe, expect, it, vi} from 'vitest';

import {clearTemplateCache, compileTemplate, renderTemplate} from '../template/index.js';

describe('compileTemplate escapeHtml (D29)', () => {
  afterEach(() => clearTemplateCache());

  it('escapes every output, array items one by one', () => {
    const output = renderTemplate(
      '<p>{{name}} {{count}} {{missing}}</p><ul>{{tags}}</ul>',
      {name: `<b>"A" & 'B'</b>`, count: 3, tags: ['<x>', 'y']},
      {escapeHtml: true},
    );

    expect(output).toBe(
      '<p>&lt;b&gt;&quot;A&quot; &amp; &#39;B&#39;&lt;/b&gt; 3 </p><ul><li>&lt;x&gt;</li>\n<li>y</li></ul>',
    );
  });

  it('leaves the template itself and `| raw` outputs alone', () => {
    expect(
      renderTemplate('<a href="{{url}}">{{html | raw}}</a>', {url: '/a?b=1&c=2', html: '<i>x</i>'}, {escapeHtml: true}),
    ).toBe('<a href="/a?b=1&amp;c=2"><i>x</i></a>');
  });

  it('escapes the output of filters and loops', () => {
    expect(
      renderTemplate(
        '{{name | upcase}}{% for item in items %}[{{item}}]{% endfor %}',
        {name: '<a>', items: ['<b>']},
        {escapeHtml: true},
      ),
    ).toBe('&lt;A&gt;[&lt;b&gt;]');
  });

  it('does not escape by default, and keeps the two parses apart', () => {
    const source = '{{name}}';
    const variables = {name: '<b>'};

    expect(compileTemplate(source, {escapeHtml: true}).render(variables)).toBe('&lt;b&gt;');
    expect(compileTemplate(source).render(variables)).toBe('<b>');
    expect(compileTemplate(source, {escapeHtml: true}).render(variables)).toBe('&lt;b&gt;');
  });

  it('escapes in the fallback renderer too', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // `{{a(b}}` is not a Liquid name, so the template goes to the fallback renderer.
    const compiled = compileTemplate('{{a(b}} {{list}}', {escapeHtml: true});

    expect(compiled.valid).toBe(false);
    expect(compiled.render({'a(b': '<b>', 'list': ['<i>']})).toBe('&lt;b&gt; <li>&lt;i&gt;</li>');
  });

  it('does not escape twice what is escaped already', () => {
    const variables = {name: '<b>A&B</b>'};
    const escaped = '&lt;b&gt;A&amp;B&lt;/b&gt;';

    expect(renderTemplate('{{name | escape}}', variables, {escapeHtml: true})).toBe(escaped);
    expect(renderTemplate('{% capture x %}{{name}}{% endcapture %}{{x}}', variables, {escapeHtml: true})).toBe(escaped);
  });

  it('escapes authored HTML in a capture unless it is printed raw', () => {
    const source = '{% capture x %}<b>hi</b>{% endcapture %}{{x}} {{x | raw}}';

    expect(renderTemplate(source, {}, {escapeHtml: true})).toBe('&lt;b&gt;hi&lt;/b&gt; <b>hi</b>');
  });

  it('refuses the tags that write values without escaping, falling back to escaped substitution', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    for (const source of ['{% echo name %}', '{% liquid echo name %}', '{% cycle name, "x" %}']) {
      const compiled = compileTemplate(`${source} {{name}}`, {escapeHtml: true});
      expect(compiled.valid).toBe(false);
      expect(compiled.render({name: '<b>'})).toContain('&lt;b&gt;');
      expect(compiled.render({name: '<b>'})).not.toContain('<b>');
    }
    // The unescaped engine keeps them.
    expect(renderTemplate('{% echo name %}', {name: '<b>'})).toBe('<b>');
  });
});

describe('CompiledTemplate.renderWithin', () => {
  afterEach(() => clearTemplateCache());

  it('renders like render when Liquid finishes in time', () => {
    expect(compileTemplate('Hi {{name}}').renderWithin({name: 'Ada'}, 50)).toBe('Hi Ada');
  });

  it('returns undefined instead of the fallback when Liquid runs out of time', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const compiled = compileTemplate(
      '{% for a in (1..100000) %}{% for b in (1..100000) %}{% endfor %}{% endfor %}{{name}}',
    );

    expect(compiled.renderWithin({name: 'Ada'}, 20)).toBeUndefined();
    // Latched: not tried again within that budget.
    expect(compiled.renderWithin({name: 'Ada'}, 20)).toBeUndefined();
    // `render` still falls back.
    expect(compiled.render({name: 'Ada'}, {renderLimitMs: 20})).toContain('Ada');
  });

  it('latches a failure within a short budget on that compiled template only, not on later sends', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const source = '{% for item in items %}{% for i in (1..1000) %}{% endfor %}{% endfor %}{{name}}';

    const oversized = compileTemplate(source);
    expect(oversized.renderWithin({items: Array.from({length: 100_000}, (_, i) => i), name: 'A'}, 20)).toBeUndefined();
    // The same compiled template does not try again within that budget...
    expect(oversized.renderWithin({items: [], name: 'A'}, 20)).toBeUndefined();
    // ...but a later compile of the same source, a later send, does.
    expect(compileTemplate(source).renderWithin({items: [1], name: 'B'}, 20)).toBe('B');
  });

  it('renders a template that does not parse with the fallback renderer', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(compileTemplate('{{a(b}}').renderWithin({'a(b': 'x'}, 50)).toBe('x');
  });
});
