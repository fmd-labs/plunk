import {simpleParser} from 'mailparser';
import {describe, expect, it} from 'vitest';

import {encodeHeaderText, filenameParameters, formatAddress, sanitizeHeaderValue} from '../mime';

// How a mail client reads these values back.
async function readSubject(value: string) {
  return (await simpleParser(`Subject: ${value}\n\nbody`)).subject;
}

async function readTo(value: string) {
  const {to} = await simpleParser(`To: ${value}\n\nbody`);
  return (Array.isArray(to) ? to : [to]).flatMap(address => address?.value ?? []);
}

/** Every encoded word of a header value (RFC 2047). */
function encodedWords(value: string) {
  return value.match(/=\?[^?]+\?[BQ]\?[^?]*\?=/g) ?? [];
}

describe('sanitizeHeaderValue', () => {
  it('turns every run of control characters into one space', () => {
    expect(sanitizeHeaderValue('Hello\r\nBcc: victim@example.com')).toBe('Hello Bcc: victim@example.com');
    expect(sanitizeHeaderValue('a\tb\x00c\x7fd')).toBe('a b c d');
  });

  it('leaves printable text alone', () => {
    expect(sanitizeHeaderValue('Grüße, "friends" <3')).toBe('Grüße, "friends" <3');
  });
});

describe('encodeHeaderText', () => {
  it('leaves printable ASCII unchanged', () => {
    expect(encodeHeaderText('Welcome aboard')).toBe('Welcome aboard');
  });

  it('keeps a line break from starting another header', async () => {
    const encoded = encodeHeaderText('Hello\r\nBcc: victim@example.com');

    expect(encoded).toBe('Hello Bcc: victim@example.com');
    expect(await readSubject(encoded)).toBe('Hello Bcc: victim@example.com');
  });

  it.each([
    ['umlauts and an emoji', 'Grüße aus München 🎉'],
    ['a long subject', `Über ${'die Bestellung '.repeat(30)}`],
    ['characters of four bytes each', '🎉'.repeat(40)],
    ['a line break in text that is not ASCII', 'Grüße\nBcc: victim@example.com'],
  ])('encodes %s as ASCII encoded words that clients read back', async (_, text) => {
    const encoded = encodeHeaderText(text);

    expect(encoded).toMatch(/^[\x20-\x7e\n]*$/);
    for (const word of encodedWords(encoded)) {
      expect(word.length).toBeLessThanOrEqual(75);
    }
    // Folded onto continuation lines, each starting with whitespace.
    for (const line of encoded.split('\n').slice(1)) {
      expect(line.startsWith(' ')).toBe(true);
    }
    expect(await readSubject(encoded)).toBe(sanitizeHeaderValue(text));
  });
});

describe('formatAddress', () => {
  it('writes an address without a name bare', () => {
    expect(formatAddress({email: 'ada@example.com'})).toBe('ada@example.com');
    expect(formatAddress({name: '  ', email: 'ada@example.com'})).toBe('ada@example.com');
  });

  it('writes a name of plain words as is', () => {
    expect(formatAddress({name: 'Ada Lovelace', email: 'ada@example.com'})).toBe('Ada Lovelace <ada@example.com>');
  });

  it.each([
    ['a comma', 'Lovelace, Ada'],
    ['quotes and a backslash', 'Ada "The Countess" L\\ovelace'],
    ['an at sign and angle brackets', 'ada@work <Lovelace>'],
    ['a dot', 'Ada A. Lovelace'],
    ['characters that are not ASCII', 'Jürgen Müller 🎉'],
  ])('quotes or encodes a name with %s, so it stays one address with that name', async (_, name) => {
    const header = formatAddress({name, email: 'ada@example.com'});

    expect(await readTo(header)).toEqual([{address: 'ada@example.com', name}]);
  });

  it('keeps a line break in a name from starting another header', async () => {
    const header = formatAddress({name: 'Ada\r\nBcc: victim@example.com', email: 'ada@example.com'});

    expect(header).not.toMatch(/[\r\n]/);
    expect(await readTo(header)).toEqual([{address: 'ada@example.com', name: 'Ada Bcc: victim@example.com'}]);
  });
});

describe('filenameParameters', () => {
  it('quotes a printable ASCII name', () => {
    expect(filenameParameters('invoice.pdf')).toBe('filename="invoice.pdf"');
    expect(filenameParameters('a "quoted" \\name.txt')).toBe('filename="a \\"quoted\\" \\\\name.txt"');
  });

  it('adds an RFC 2231 name in UTF-8 for a name that is not ASCII', () => {
    expect(filenameParameters("Rechnung März (1)'.pdf")).toBe(
      "filename=\"Rechnung M_rz (1)'.pdf\"; filename*=UTF-8''Rechnung%20M%C3%A4rz%20%281%29%27.pdf",
    );
  });

  it('drops line breaks from the name', () => {
    expect(filenameParameters('a\r\nb.txt')).toBe('filename="a b.txt"');
  });
});
