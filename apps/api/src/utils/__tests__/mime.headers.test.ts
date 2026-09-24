import {simpleParser} from 'mailparser';
import {describe, expect, it} from 'vitest';

import {
  attachmentContentDisposition,
  attachmentContentType,
  encodeHeaderText,
  formatAddress,
  formatAddressList,
  sanitizeHeaderValue,
} from '../mime';

// How a mail client reads these values back.
async function readSubject(value: string) {
  return (await simpleParser(`Subject: ${value}\n\nbody`)).subject;
}

async function readAddresses(name: 'From' | 'To', value: string) {
  const parsed = await simpleParser(`${name}: ${value}\n\nbody`);
  const field = name === 'From' ? parsed.from : parsed.to;
  return (Array.isArray(field) ? field : [field]).flatMap(address => address?.value ?? []);
}

/** Every encoded word of a header value (RFC 2047). */
function encodedWords(value: string) {
  return value.match(/=\?[^?]+\?[BQ]\?[^?]*\?=/g) ?? [];
}

/** The lines of a header as the message holds them: its name, then its folded value. */
function headerLines(name: string, value: string) {
  return `${name}: ${value}`.split('\n');
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
    expect(encodeHeaderText('Subject', 'Welcome aboard')).toBe('Welcome aboard');
  });

  it('keeps a line break from starting another header', async () => {
    const encoded = encodeHeaderText('Subject', 'Hello\r\nBcc: victim@example.com');

    expect(encoded).toBe('Hello Bcc: victim@example.com');
    expect(await readSubject(encoded)).toBe('Hello Bcc: victim@example.com');
  });

  it.each([
    ['umlauts and an emoji', 'Grüße aus München 🎉'],
    ['a long subject', `Über ${'die Bestellung '.repeat(30)}`],
    ['characters of four bytes each', '🎉'.repeat(40)],
    ['a line break in text that is not ASCII', 'Grüße\nBcc: victim@example.com'],
  ])('encodes %s as folded encoded words that clients read back', async (_, text) => {
    const encoded = encodeHeaderText('Subject', text);

    expect(encoded).toMatch(/^[\x20-\x7e\n]*$/);
    for (const word of encodedWords(encoded)) {
      expect(word.length).toBeLessThanOrEqual(75);
    }
    // RFC 2047: a line holding encoded words is at most 76 characters; continuation lines start with a space.
    const [first, ...continuations] = headerLines('Subject', encoded);
    for (const line of [first!, ...continuations]) {
      expect(line.length).toBeLessThanOrEqual(76);
    }
    for (const line of continuations) {
      expect(line.startsWith(' ')).toBe(true);
    }
    expect(await readSubject(encoded)).toBe(sanitizeHeaderValue(text));
  });

  it('starts on a continuation line after a name that leaves no room', () => {
    const name = 'X-'.padEnd(60, 'a');
    const encoded = encodeHeaderText(name, 'Grüße');

    expect(encoded.startsWith('\n ')).toBe(true);
    for (const line of headerLines(name, encoded)) {
      expect(line.length).toBeLessThanOrEqual(76);
    }
  });

  it('fits the first line after the name of the header', () => {
    const [first] = headerLines(
      'X-Campaign-Description',
      encodeHeaderText('X-Campaign-Description', 'Grüße '.repeat(20)),
    );

    expect(first!.length).toBeLessThanOrEqual(76);
  });
});

describe('formatAddress', () => {
  it('writes an address without a name bare', () => {
    expect(formatAddress({email: 'ada@example.com'}, 4)).toBe('ada@example.com');
    expect(formatAddress({name: '  ', email: 'ada@example.com'}, 4)).toBe('ada@example.com');
  });

  it('writes a name of plain words as is', () => {
    expect(formatAddress({name: 'Ada Lovelace', email: 'ada@example.com'}, 4)).toBe('Ada Lovelace <ada@example.com>');
  });

  it.each([
    ['a comma', 'Lovelace, Ada'],
    ['quotes and a backslash', 'Ada "The Countess" L\\ovelace'],
    ['an at sign and angle brackets', 'ada@work <Lovelace>'],
    ['a dot', 'Ada A. Lovelace'],
    ['characters that are not ASCII', 'Jürgen Müller 🎉'],
  ])('quotes or encodes a name with %s, so it stays one address with that name', async (_, name) => {
    const header = formatAddress({name, email: 'ada@example.com'}, 4);

    expect(await readAddresses('To', header)).toEqual([{address: 'ada@example.com', name}]);
  });

  it('folds a long name that is not ASCII into lines of at most 76 characters', async () => {
    const name = '株式会社サンプル東京本社'.repeat(12);
    const header = formatAddress({name, email: 'accounts-receivable@example.com'}, 'From: '.length);

    for (const line of headerLines('From', header)) {
      expect(line.length).toBeLessThanOrEqual(76);
    }
    expect(await readAddresses('From', header)).toEqual([{address: 'accounts-receivable@example.com', name}]);
  });

  it('keeps a line break in a name from starting another header', async () => {
    const header = formatAddress({name: 'Ada\r\nBcc: victim@example.com', email: 'ada@example.com'}, 4);

    expect(header).not.toMatch(/[\r\n]/);
    expect(await readAddresses('To', header)).toEqual([
      {address: 'ada@example.com', name: 'Ada Bcc: victim@example.com'},
    ]);
  });
});

describe('formatAddressList', () => {
  it('joins addresses that fit on one line, as upstream writes them', () => {
    expect(formatAddressList([{email: 'ada@example.com'}, {name: 'Bob', email: 'bob@example.com'}], 4)).toBe(
      'ada@example.com, Bob <bob@example.com>',
    );
  });

  it('starts a continuation line for an address that does not fit', async () => {
    const addresses = Array.from({length: 5}, (_, index) => ({
      name: `Jürgen Müller ${index}`,
      email: `jurgen-${index}@example.com`,
    }));
    const list = formatAddressList(addresses, 'To: '.length);

    expect(list).toContain(',\n ');
    for (const line of headerLines('To', list)) {
      expect(line.length).toBeLessThanOrEqual(76);
    }
    expect(await readAddresses('To', list)).toEqual(addresses.map(({name, email}) => ({address: email, name})));
  });
});

describe('attachmentContentDisposition', () => {
  it('quotes a printable ASCII name, as upstream writes it', () => {
    expect(attachmentContentDisposition('attachment', 'invoice.pdf')).toBe('attachment; filename="invoice.pdf"');
    expect(attachmentContentDisposition('inline', 'a "quoted" \\name.txt')).toBe(
      'inline; filename="a \\"quoted\\" \\\\name.txt"',
    );
  });

  it('writes a name that is not ASCII as an RFC 2231 name in UTF-8, without an ASCII fallback', () => {
    expect(attachmentContentDisposition('attachment', "März (1)'.pdf")).toBe(
      "attachment; filename*=UTF-8''M%C3%A4rz%20%281%29%27.pdf",
    );
  });

  it('splits a long name into numbered continuations of at most 78 characters, never inside an escape', () => {
    const value = attachmentContentDisposition('attachment', `${'請求書'.repeat(80)}.pdf`);
    const [first, ...continuations] = headerLines('Content-Disposition', value);

    expect(first).toBe('Content-Disposition: attachment;');
    expect(continuations.length).toBeGreaterThan(1);
    continuations.forEach((line, index) => {
      expect(line.length).toBeLessThanOrEqual(78);
      expect(line).toMatch(
        new RegExp(`^ filename\\*${index}\\*=${index === 0 ? "UTF-8''" : ''}(%[0-9A-F]{2}|[^%;])+;?$`),
      );
    });
  });

  it('drops line breaks from the name', () => {
    expect(attachmentContentDisposition('attachment', 'a\r\nb.txt')).toBe('attachment; filename="a b.txt"');
  });
});

describe('attachmentContentType', () => {
  it('leaves the type alone for an ASCII name, as upstream writes it', () => {
    expect(attachmentContentType('application/pdf', 'invoice.pdf')).toBe('application/pdf');
  });

  it('names an attachment that is not ASCII in encoded words, for clients that do not read RFC 2231', () => {
    expect(attachmentContentType('application/pdf', 'Rechnung März.pdf')).toBe(
      `application/pdf;\n name="=?UTF-8?B?${Buffer.from('Rechnung März.pdf').toString('base64')}?="`,
    );
  });

  it('keeps every line of a long name within 76 characters', () => {
    for (const line of headerLines('Content-Type', attachmentContentType('application/pdf', '請求書'.repeat(80)))) {
      expect(line.length).toBeLessThanOrEqual(76);
    }
  });

  it('keeps a line break in the type from starting another header', () => {
    expect(attachmentContentType('text/plain\r\nX-Injected: 1', 'a.txt')).toBe('text/plain X-Injected: 1');
  });
});
