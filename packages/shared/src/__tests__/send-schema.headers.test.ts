import {describe, expect, it} from 'vitest';

import {ActionSchemas} from '../schemas/index.js';

const valid = {to: 'ada@example.com', subject: 'Hello', body: '<p>Hello</p>'};

/**
 * Every value of a send request that ends up in a message header must be a single line: a line
 * break would start another header.
 */
describe('ActionSchemas.send header fields', () => {
  it.each([
    ['a recipient name', {to: {name: 'Ada\r\nBcc: victim@example.com', email: 'ada@example.com'}}],
    [
      'a recipient name in a list',
      {to: ['bob@example.com', {name: 'Ada\nBcc: x@example.com', email: 'ada@example.com'}]},
    ],
    ['the sender name', {name: 'Acme\nBcc: victim@example.com'}],
    [
      'an attachment content type',
      {attachments: [{filename: 'a.txt', content: 'SGVsbG8=', contentType: 'text/plain\r\nX-Injected: 1'}]},
    ],
  ])('rejects a line break in %s', (_, fields) => {
    expect(ActionSchemas.send.safeParse({...valid, ...fields}).success).toBe(false);
  });

  it('accepts names that are not ASCII or contain commas', () => {
    const result = ActionSchemas.send.safeParse({
      ...valid,
      to: [
        {name: 'Lovelace, Ada', email: 'ada@example.com'},
        {name: 'Jürgen Müller', email: 'jurgen@example.com'},
      ],
      name: 'Café Crème',
    });

    expect(result.success).toBe(true);
  });
});
