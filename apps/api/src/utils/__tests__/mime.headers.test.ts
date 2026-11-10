import {describe, expect, it} from 'vitest';

import {sanitizeHeaderValue} from '../mime';

describe('sanitizeHeaderValue', () => {
  it('turns every run of control characters into one space', () => {
    expect(sanitizeHeaderValue('Hello\r\nBcc: victim@example.com')).toBe('Hello Bcc: victim@example.com');
    expect(sanitizeHeaderValue('a\tb\x00c\x7fd')).toBe('a b c d');
  });

  it('leaves printable text alone', () => {
    expect(sanitizeHeaderValue('Grüße, "friends" <3')).toBe('Grüße, "friends" <3');
  });
});
