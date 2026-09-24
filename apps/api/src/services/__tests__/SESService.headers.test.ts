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
      content: {subject: 'Hello\r\nX-Injected: subject', html: '<p>Hi</p>'},
      headers: {'X-Entity-Ref-ID': 'ref\r\nX-Injected: header'},
    });

    const parsed = await simpleParser(mime);
    expect(parsed.headers.has('bcc')).toBe(false);
    expect(parsed.headers.has('x-injected')).toBe(false);
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
});
