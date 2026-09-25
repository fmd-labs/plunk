import {simpleParser} from 'mailparser';
import {describe, expect, it} from 'vitest';

import {buildRawEmail} from '../SESService';

const PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

/** The header section of a raw message: everything before the first blank line. */
function headerSection(mime: string) {
  return mime.slice(0, mime.indexOf('\n\n'));
}

function addresses(field: Awaited<ReturnType<typeof simpleParser>>['to']) {
  return (Array.isArray(field) ? field : [field]).flatMap(address => address?.value ?? []);
}

describe('SES raw email headers', () => {
  it('encodes a subject and display names that are not ASCII, so clients read them back', async () => {
    const {mime, source} = buildRawEmail({
      from: {name: 'Café Crème', email: 'hello@acme.test'},
      to: [
        {name: 'Jürgen Müller', email: 'jurgen@example.com'},
        {name: 'Lovelace, Ada', email: 'ada@example.com'},
      ],
      content: {subject: 'Grüße aus München 🎉 — Ihre Bestellung', html: '<p>Hallo</p>'},
      headers: {'X-Campaign-Label': 'Frühling'},
    });

    // RFC 5322 headers are ASCII.
    expect(headerSection(mime)).toMatch(/^[\x20-\x7e\n]*$/);

    const parsed = await simpleParser(mime);
    expect(parsed.subject).toBe('Grüße aus München 🎉 — Ihre Bestellung');
    expect(addresses(parsed.from)).toEqual([{address: 'hello@acme.test', name: 'Café Crème'}]);
    expect(addresses(parsed.to)).toEqual([
      {address: 'jurgen@example.com', name: 'Jürgen Müller'},
      {address: 'ada@example.com', name: 'Lovelace, Ada'},
    ]);
    // mailparser decodes only the headers it knows; the value is the encoded word for `Frühling`.
    expect(parsed.headers.get('x-campaign-label')).toBe('=?UTF-8?B?RnLDvGhsaW5n?=');
    // SES's envelope sender takes the address alone.
    expect(source).toBe('hello@acme.test');
  });

  it('keeps line breaks in names, the subject and header values from adding headers', async () => {
    const {mime} = buildRawEmail({
      from: {name: 'Acme\r\nBcc: victim@example.com', email: 'hello@acme.test'},
      to: [{name: 'Ada\nX-Injected: to', email: 'ada@example.com'}],
      content: {subject: 'Hello\r\nX-Injected: subject', html: '<p>Hi <img src="cid:logo"></p>'},
      headers: {
        'X-Entity-Ref-ID': 'ref\r\nX-Injected: header',
        'List-Unsubscribe': '<https://acme.test/u>\r\nX-Injected: structured',
        'X-Name\r\nX-Injected': 'name',
      },
      attachments: [
        {
          filename: 'logo.png',
          content: PIXEL_PNG,
          contentType: 'image/png',
          contentId: 'logo\r\nX-Injected: cid',
          disposition: 'inline',
        },
      ],
    });

    const parsed = await simpleParser(mime);
    expect(parsed.headers.has('bcc')).toBe(false);
    expect(parsed.headers.has('x-injected')).toBe(false);
    expect(parsed.attachments.some(attachment => attachment.headers.has('x-injected'))).toBe(false);
    expect(parsed.subject).toBe('Hello X-Injected: subject');
    expect(addresses(parsed.to)).toEqual([{address: 'ada@example.com', name: 'Ada X-Injected: to'}]);
  });

  it('names attachments that are not ASCII, so clients show their names', async () => {
    const {mime} = buildRawEmail({
      from: {name: 'Acme', email: 'billing@acme.test'},
      to: ['ada@example.com'],
      content: {subject: 'Files', html: '<p>Files <img src="cid:logo"></p>'},
      attachments: [
        {filename: 'Rechnung März.pdf', content: 'SGVsbG8=', contentType: 'application/pdf'},
        {
          filename: 'Logo €.png',
          content: PIXEL_PNG,
          contentType: 'image/png',
          contentId: 'logo',
          disposition: 'inline',
        },
      ],
    });

    const parsed = await simpleParser(mime);
    expect(parsed.attachments.map(attachment => attachment.filename).sort()).toEqual([
      'Logo €.png',
      'Rechnung März.pdf',
    ]);
  });

  it('keeps every line within 78 characters for long names that are not ASCII', async () => {
    const name = '株式会社サンプル東京本社'.repeat(16);
    const filename = `${'請求書'.repeat(83)}.pdf`;
    const {mime} = buildRawEmail({
      from: {name, email: 'billing@acme.test'},
      to: [{name, email: 'ada@example.com'}],
      content: {subject: `${'請求書'.repeat(40)} 🎉`, html: '<p>Anbei</p>'},
      attachments: [{filename, content: 'SGVsbG8=', contentType: 'application/pdf'}],
    });

    // RFC 5322 caps lines at 998 characters and asks for 78; a relay may otherwise refold them.
    for (const line of mime.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(78);
    }
    // RFC 2047: a line that holds encoded words is at most 76 characters.
    for (const line of mime.split('\n').filter(line => line.includes('=?'))) {
      expect(line.length).toBeLessThanOrEqual(76);
    }
    const parsed = await simpleParser(mime);
    expect(addresses(parsed.from)).toEqual([{address: 'billing@acme.test', name}]);
    expect(addresses(parsed.to)).toEqual([{address: 'ada@example.com', name}]);
    expect(parsed.attachments.map(attachment => attachment.filename)).toEqual([filename]);
  });

  it('keeps lines within 76 characters for several named recipients and a long x- header name', async () => {
    const recipients = Array.from({length: 6}, (_, index) => ({
      name: `株式会社サンプル ${index}`,
      email: `recipient-${index}@example.com`,
    }));
    const name = 'x-campaign-description-for-the-quarterly-report-of-the-company';
    const {mime} = buildRawEmail({
      from: {name: 'Acme', email: 'hello@acme.test'},
      to: recipients,
      content: {subject: 'Hello', html: '<p>Hi</p>'},
      headers: {[name]: 'Grüße aus München'},
    });

    for (const line of mime.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(76);
    }
    const parsed = await simpleParser(mime);
    expect(addresses(parsed.to)).toEqual(recipients.map(({name, email}) => ({address: email, name})));
    expect(parsed.headers.get(name)).toMatch(/^=\?UTF-8\?B\?/);
  });

  it('names attachments whose names mix scripts or hold a lone surrogate', async () => {
    const mixed = `${'Rechnung-März-'.repeat(8)}.pdf`;
    const cut = `Bericht ${String.fromCharCode(0xd83d)}.pdf`;
    const {mime} = buildRawEmail({
      from: {name: 'Acme', email: 'billing@acme.test'},
      to: ['ada@example.com'],
      content: {subject: 'Files', html: '<p>Files</p>'},
      attachments: [
        {filename: mixed, content: 'SGVsbG8=', contentType: 'application/pdf'},
        {filename: cut, content: 'SGVsbG8=', contentType: 'application/pdf'},
      ],
    });

    for (const line of mime.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(78);
    }
    const parsed = await simpleParser(mime);
    expect(parsed.attachments.map(attachment => attachment.filename)).toEqual([mixed, 'Bericht �.pdf']);
  });

  it('leaves out a header whose name is not a field name', async () => {
    const {mime} = buildRawEmail({
      from: {name: 'Acme', email: 'hello@acme.test'},
      to: ['ada@example.com'],
      content: {subject: 'Hello', html: '<p>Hi</p>'},
      headers: {'X-Two Words': 'a', 'X-Colon:': 'b', 'X-Ümlaut': 'c', 'X-Fine': 'd'},
    });

    const header = mime.slice(0, mime.indexOf('\n\n'));
    expect(header).toContain('\nX-Fine: d');
    expect(header).not.toMatch(/X-Two|X-Colon|X-Ümlaut/);
  });

  it('writes headers other than X- headers as they are, so their structure stays readable', async () => {
    const {mime} = buildRawEmail({
      from: {name: 'Acme', email: 'hello@acme.test'},
      to: ['ada@example.com'],
      content: {subject: 'Hello', html: '<p>Hi</p>'},
      headers: {'Cc': 'Jürgen Müller <jurgen@example.com>', 'X-Label': 'Frühling'},
    });

    expect(headerSection(mime)).toContain('\nCc: Jürgen Müller <jurgen@example.com>\n');
    const parsed = await simpleParser(mime);
    expect(addresses(parsed.cc)).toEqual([{address: 'jurgen@example.com', name: 'Jürgen Müller'}]);
    expect(parsed.headers.get('x-label')).toBe('=?UTF-8?B?RnLDvGhsaW5n?=');
  });

  it('quotes an ASCII display name with special characters', () => {
    const {mime} = buildRawEmail({
      from: {name: 'Acme Inc.', email: 'hello@acme.test'},
      to: ['ada@example.com'],
      content: {subject: 'Hello', html: '<p>Hi</p>'},
    });

    expect(mime.split('\n')[0]).toBe('From: "Acme Inc." <hello@acme.test>');
  });

  it('keeps a line break in an attachment content type from adding headers', async () => {
    const {mime} = buildRawEmail({
      from: {name: 'Acme', email: 'hello@acme.test'},
      to: ['ada@example.com'],
      content: {subject: 'Files', html: '<p>Files</p>'},
      attachments: [{filename: 'a.txt', content: 'SGVsbG8=', contentType: 'text/plain\r\nX-Injected: 1'}],
    });

    const parsed = await simpleParser(mime);
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]?.headers.has('x-injected')).toBe(false);
  });

  it('keeps a Content-ID taken from a file name within its angle brackets', () => {
    const {mime} = buildRawEmail({
      from: {name: 'Acme', email: 'hello@acme.test'},
      to: ['ada@example.com'],
      content: {subject: 'Logo', html: '<p><img src="cid:logo1.png"></p>'},
      attachments: [{filename: 'logo<1>.png', content: PIXEL_PNG, contentType: 'image/png', disposition: 'inline'}],
    });

    expect(mime).toContain('\nContent-ID: <logo1.png>\n');
  });
});
