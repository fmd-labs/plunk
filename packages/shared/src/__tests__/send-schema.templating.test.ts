import {describe, expect, it} from 'vitest';

import {ActionSchemas} from '../schemas/index.js';

const valid = {to: 'ada@example.com', subject: 'Hello {{name}}', body: '<p>{% raw %}</p>'};

function issues(fields: Record<string, unknown>) {
  const result = ActionSchemas.send.safeParse({...valid, ...fields});
  return result.success ? [] : result.error.issues.map(issue => ({path: issue.path.join('.'), message: issue.message}));
}

describe('ActionSchemas.send templating and headers', () => {
  it('accepts templating off with a subject and body', () => {
    expect(issues({templating: false})).toEqual([]);
    expect(issues({templating: true})).toEqual([]);
  });

  it('refuses templating off with a template, whose content is written to be filled in', () => {
    const result = ActionSchemas.send.safeParse({
      to: 'ada@example.com',
      template: '00000000-0000-4000-8000-000000000000',
      templating: false,
    });

    expect(result.success).toBe(false);
    expect(result.error?.issues).toEqual([
      expect.objectContaining({path: ['templating'], message: 'templating: false cannot be combined with a template'}),
    ]);
  });

  it.each(['X-Plunk-Recipient-Override', 'x-plunk-templating', 'X-PLUNK-Anything'])(
    'refuses the reserved header %s',
    name => {
      expect(issues({headers: {[name]: 'value'}})).toEqual([
        {path: `headers.${name}`, message: 'X-Plunk-* headers are reserved for Plunk'},
      ]);
    },
  );

  it.each(['X Custom', 'X-Custom:', 'Käse', ''])('refuses the header name %j', name => {
    expect(issues({headers: {[name]: 'value'}})).not.toEqual([]);
  });

  it('accepts the three priorities and nothing else', () => {
    for (const priority of ['high', 'normal', 'low']) {
      expect(issues({priority})).toEqual([]);
    }
    expect(issues({priority: 'urgent'})).not.toEqual([]);
    expect(issues({priority: 1})).not.toEqual([]);
  });

  it('accepts custom and standard header names', () => {
    expect(issues({headers: {'X-Entity-Ref-ID': 'ref-1', 'List-Unsubscribe': '<https://example.com/u>'}})).toEqual([]);
  });
});
