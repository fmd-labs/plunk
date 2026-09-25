import {convert} from 'html-to-text';

/**
 * Derive the `text/plain` alternative for an HTML email body.
 *
 * Every message we send is a `multipart/alternative`, so a missing text part is not
 * merely a lost fallback — it is a container that advertises alternatives and then
 * offers none. Spam filters read that as evasion: SpamAssassin scores `MIME_HTML_ONLY`
 * (+2.0) and `MPART_ALT_DIFF` (+0.7) on it, which is enough to push an otherwise clean
 * message most of the way to a spam verdict.
 *
 * The conversion has to stay *faithful* to the HTML to be worth doing. A stripped-tags
 * blob that drops link targets scores worse than no text part at all, because a text
 * part whose content diverges from the HTML is exactly the shape of a filter-evasion
 * message. Hence `html-to-text` rather than a regex: it renders links as `text [url]`,
 * keeps list and table structure, and falls back to image alt text.
 */
export function htmlToPlainText(html: string): string {
  return convert(html, {
    // Long lines are handled by the quoted-printable encoder at send time, which can
    // break anywhere without changing how the text renders. Wrapping here instead
    // would bake hard newlines into the content and re-flow the recipient's message.
    wordwrap: false,
    selectors: [
      // Tracking pixels and spacer images carry no meaning, and their alt text (when
      // they have any) is noise in a reading order.
      {selector: 'img', format: 'skip'},
      // Plunk's editor emits table-based layout, not tabular data. Rendering those as
      // ASCII tables would turn a normal email into a wall of pipes and dashes.
      {selector: 'table', format: 'block'},
      {selector: 'td', format: 'block'},
      {selector: 'tr', format: 'block'},
      // `text [url]` beats a bare URL: it keeps the anchor text that tells the reader
      // where the link goes, which is what keeps the two parts semantically equal.
      {selector: 'a', options: {hideLinkHrefIfSameAsText: true}},
      // html-to-text upper-cases headings by default. Left on, a normal email subject
      // line becomes SHOUTING in the text part and feeds the caps-ratio heuristics
      // this whole change exists to stay clear of.
      {selector: 'h1', options: {uppercase: false}},
      {selector: 'h2', options: {uppercase: false}},
      {selector: 'h3', options: {uppercase: false}},
      {selector: 'h4', options: {uppercase: false}},
      {selector: 'h5', options: {uppercase: false}},
      {selector: 'h6', options: {uppercase: false}},
    ],
  });
}

/**
 * Encode a string as quoted-printable (RFC 2045 §6.7).
 *
 * Needed because our parts declare `charset=utf-8`, and UTF-8 is not 7-bit safe: a
 * single emoji or accented character makes a `Content-Transfer-Encoding: 7bit` header
 * a lie about the bytes on the wire. Quoted-printable is the right fix rather than
 * base64, which would trip SpamAssassin's `MIME_BASE64_TEXT` and trade one rule hit
 * for another.
 *
 * It also solves line length. RFC 5322 §2.1.1 caps a line at 998 characters, and
 * quoted-printable's soft line break (`=` at end of line) lets us satisfy that
 * invisibly — the break vanishes when the client decodes it, so unlike a hard wrap it
 * cannot re-flow the recipient's text or split a long URL.
 */
export function encodeQuotedPrintable(input: string): string {
  // Normalize every line ending to a lone LF first, so the joins below are the only
  // place line endings are produced and a CRLF in the input cannot become CRCRLF.
  //
  // LF rather than the CRLF the RFC asks for, to match the rest of the raw message
  // (see `sendRawEmail`), which has always used bare LF and which SES normalizes on
  // the way out. Emitting CRLF only inside part bodies would risk a normalizer that
  // rewrites every LF turning our CRLF into CRCRLF.
  return input
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map(line => wrapQuotedPrintableLine(encodeLineTokens(line)))
    .join('\n');
}

/**
 * Encode one line into atomic tokens, each either a literal character or an `=XX` group.
 *
 * Tokenizing matters because an `=XX` escape cannot be split across a line break — the
 * decoder would read the fragments as literal text, which is how mojibake gets into an
 * otherwise correct message. Emitting whole tokens makes that unrepresentable rather
 * than something the wrapper has to remember to check for.
 */
function encodeLineTokens(line: string): string[] {
  // Byte-wise, not character-wise: a multi-byte UTF-8 character must become one `=XX`
  // group per byte. Iterating JS characters would emit code points instead and produce
  // something no decoder can read back.
  const bytes = new TextEncoder().encode(line);

  return Array.from(bytes, byte => {
    // `=` starts an escape, so it must itself be escaped.
    if (byte === 61) {
      return '=3D';
    }
    // Tab and space are legal literals except at end of line, handled by the wrapper.
    if (byte === 9 || byte === 32 || (byte >= 33 && byte <= 126)) {
      return String.fromCharCode(byte);
    }
    return `=${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  });
}

/**
 * Soft-wrap an encoded line to the 76-character limit quoted-printable imposes
 * (RFC 2045 §6.7).
 *
 * The budget is 73 rather than 75 because the last token on a line may still grow: a
 * literal space or tab immediately before a break is stripped by intermediate servers,
 * so it has to be re-encoded as `=20`/`=09`, costing two more columns. Reserving those
 * up front means the escape can never push the line over the limit.
 */
function wrapQuotedPrintableLine(tokens: string[]): string {
  const contentBudget = 73;

  const lines: string[] = [];
  let current = '';

  const flush = (soft: boolean) => {
    // Trailing whitespace does not survive transit, so encode it explicitly. This
    // applies to the final line too: a soft break is not the only thing that can leave
    // whitespace exposed at the end of a line.
    if (current.endsWith(' ')) {
      current = `${current.slice(0, -1)}=20`;
    } else if (current.endsWith('\t')) {
      current = `${current.slice(0, -1)}=09`;
    }

    lines.push(soft ? `${current}=` : current);
    current = '';
  };

  for (const token of tokens) {
    if (current.length + token.length > contentBudget) {
      flush(true);
    }
    current += token;
  }

  flush(false);
  return lines.join('\n');
}

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

// RFC 2047 §2: an encoded word is at most 75 characters, and a line that holds one at most 76.
const MAX_ENCODED_WORD = 75;
const MAX_ENCODED_LINE = 76;
// RFC 5322 §2.1.1: a line should be at most 78 characters.
const MAX_LINE = 78;
// An encoded word worth starting a line with: its 12 characters of framing and a few characters.
const MIN_ENCODED_WORD = 24;

/**
 * Make a value safe to write into a header: every run of control characters becomes a
 * single space.
 *
 * A line break in a header value ends that header and starts another, so a subject
 * rendered from contact data, or a display name, could otherwise inject headers or cut
 * the header section short. Values reach the message builder from templates, campaigns
 * and workflows as well as from the API, so the builder cannot rely on input validation.
 */
export function sanitizeHeaderValue(value: string): string {
  // eslint-disable-next-line no-control-regex -- control characters are what this replaces
  return value.replace(/[\x00-\x1f\x7f]+/g, ' ');
}

/** The UTF-8 bytes an encoded word can carry on a line that already holds `offset` characters. */
function encodedWordBytes(offset: number): number {
  // `=?UTF-8?B?` and `?=` take 12 characters, and base64 writes 3 bytes as 4 characters.
  const base64Length = Math.min(MAX_ENCODED_WORD, MAX_ENCODED_LINE - offset) - 12;
  return Math.max(3, Math.floor(base64Length / 4) * 3);
}

/**
 * Encode text as RFC 2047 encoded words (UTF-8, base64) for a folded header, never splitting a
 * character: the first word fits on a line that already holds `offset` characters, and each
 * later one on a continuation line of its own. Decoders join adjacent encoded words without the
 * whitespace between them.
 */
function encodedWords(text: string, offset: number): string[] {
  const chunks: string[] = [];
  let chunk = '';
  let maxBytes = encodedWordBytes(offset);
  for (const character of text) {
    if (chunk !== '' && Buffer.byteLength(chunk + character) > maxBytes) {
      chunks.push(chunk);
      chunk = '';
      // A continuation line starts with a space.
      maxBytes = encodedWordBytes(1);
    }
    chunk += character;
  }
  if (chunk !== '') {
    chunks.push(chunk);
  }
  return chunks.map(part => `=?UTF-8?B?${Buffer.from(part, 'utf8').toString('base64')}?=`);
}

/**
 * Encode an unstructured header value, such as a subject: unchanged when it is printable
 * ASCII, otherwise as RFC 2047 encoded words folded onto continuation lines. `name` is the
 * header's name, which starts the value's first line. Mail clients show a raw UTF-8 header
 * as mojibake, and servers may reject it (RFC 5322 headers are ASCII).
 */
export function encodeHeaderText(name: string, value: string): string {
  const text = sanitizeHeaderValue(value);
  if (PRINTABLE_ASCII.test(text)) {
    return text;
  }
  const offset = `${name}: `.length;
  // After a name too long to leave room for a word, the value starts on a continuation line.
  return offset + MIN_ENCODED_WORD > MAX_ENCODED_LINE
    ? `\n ${encodedWords(text, 1).join('\n ')}`
    : encodedWords(text, offset).join('\n ');
}

/**
 * Format an address for a From, To or similar header: the bare address, or
 * `name <address>` with the display name as an RFC 5322 phrase. A name of plain words is
 * written as is; one with special characters is quoted, as a comma would otherwise split
 * the address list and `<` or `@` would change the address; a name that is not ASCII is
 * written as encoded words, folded like `encodeHeaderText`, with the address after the
 * last word or on a line of its own. `offset` is what precedes the address on its line,
 * such as `From: `, and `reserve` what follows it, such as the comma of an address list.
 */
export function formatAddress({name, email}: {name?: string; email: string}, offset: number, reserve = 0): string {
  const address = sanitizeHeaderValue(email).trim();
  const phrase = sanitizeHeaderValue(name ?? '').trim();
  if (phrase === '') {
    return address;
  }
  if (!PRINTABLE_ASCII.test(phrase)) {
    const words = encodedWords(phrase, offset);
    const last = words[words.length - 1]!;
    const lastLine = words.length === 1 ? offset + last.length : ` ${last}`.length;
    const separator = lastLine + ` <${address}>`.length + reserve <= MAX_ENCODED_LINE ? ' ' : '\n ';
    return `${words.join('\n ')}${separator}<${address}>`;
  }
  // RFC 5322 atext, and the spaces between words.
  if (/^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~ ]+$/.test(phrase)) {
    return `${phrase} <${address}>`;
  }
  return `"${phrase.replace(/(["\\])/g, '\\$1')}" <${address}>`;
}

/**
 * Format a list of addresses for a To or similar header, `offset` characters into its first line.
 * An address that does not fit on the current line starts a continuation line, so that however
 * many addresses there are, lines stay within 76 characters.
 */
export function formatAddressList(addresses: {name?: string; email: string}[], offset: number): string {
  let list = '';
  let line = offset;
  for (const [index, address] of addresses.entries()) {
    // Room for the comma that ends the line when the next address starts a continuation line.
    const reserve = index < addresses.length - 1 ? 1 : 0;
    let separator = list === '' ? '' : ', ';
    let formatted = formatAddress(address, line + separator.length, reserve);
    const [firstLine, ...rest] = formatted.split('\n');
    // A first line that continues ends with an encoded word, and the comma goes on the last line.
    const fits = line + separator.length + firstLine!.length + (rest.length > 0 ? 0 : reserve) <= MAX_ENCODED_LINE;
    if (list !== '' && !fits) {
      separator = ',\n ';
      formatted = formatAddress(address, 1, reserve);
      line = 1;
    } else {
      line += separator.length;
    }
    list += separator + formatted;
    const lines = formatted.split('\n');
    line = lines.length > 1 ? lines[lines.length - 1]!.length : line + formatted.length;
  }
  return list;
}

/** Percent-encode a value for an RFC 2231 parameter; letters, digits and `-_.!~` stay literal. */
function percentEncode(value: string): string {
  // Byte by byte, so that a lone surrogate becomes U+FFFD as in the other encoders, where
  // `encodeURIComponent` would throw.
  let encoded = '';
  for (const byte of Buffer.from(value, 'utf8')) {
    const character = String.fromCharCode(byte);
    encoded += /[A-Za-z0-9\-_.!~]/.test(character) ? character : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return encoded;
}

/**
 * The value of an attachment's Content-Type header. A file name that is not ASCII adds a
 * `name` parameter in RFC 2047 encoded words, from which clients that do not read RFC 2231
 * (older Outlook versions) take the name. An ASCII name adds nothing, as upstream.
 */
export function attachmentContentType(contentType: string, filename: string): string {
  const type = sanitizeHeaderValue(contentType);
  const name = sanitizeHeaderValue(filename);
  if (PRINTABLE_ASCII.test(name)) {
    return type;
  }
  return `${type};\n name="${encodedWords(name, ' name="'.length).join('\n ')}"`;
}

/**
 * The value of an attachment's Content-Disposition header, `attachment` or `inline` with
 * the file name. A printable ASCII name is a quoted `filename`, as upstream. Any other name
 * is an RFC 2231 `filename*` in UTF-8, in numbered continuations where one line would pass
 * 78 characters. It comes without an ASCII `filename`, which parsers that find both read
 * instead.
 */
export function attachmentContentDisposition(disposition: string, filename: string): string {
  const name = sanitizeHeaderValue(filename);
  if (PRINTABLE_ASCII.test(name)) {
    return `${disposition}; filename="${name.replace(/(["\\])/g, '\\$1')}"`;
  }

  const encoded = percentEncode(name);
  const single = `${disposition}; filename*=UTF-8''${encoded}`;
  if (`Content-Disposition: ${single}`.length <= MAX_LINE) {
    return single;
  }

  // One continuation per line, never splitting a character: a parser that decodes each continuation
  // on its own would break a character whose bytes span two of them.
  const segments: string[] = [];
  let segment = '';
  for (const unit of Array.from(name, percentEncode)) {
    const prefix = ` filename*${segments.length}*=${segments.length === 0 ? "UTF-8''" : ''}`;
    if (segment !== '' && `${prefix}${segment}${unit};`.length > MAX_LINE) {
      segments.push(segment);
      segment = '';
    }
    segment += unit;
  }
  segments.push(segment);

  const parameters = segments.map((part, index) => `filename*${index}*=${index === 0 ? "UTF-8''" : ''}${part}`);
  return `${disposition};\n ${parameters.join(';\n ')}`;
}
