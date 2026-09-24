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
  return value.replace(/[\x00-\x1f\x7f]+/g, ' ');
}

/**
 * Encode non-ASCII text as RFC 2047 encoded words: UTF-8, base64, each word at most 75
 * characters (RFC 2047 §2) and never splitting a character. Decoders join adjacent
 * encoded words without the whitespace between them.
 */
function encodedWords(text: string): string[] {
  // `=?UTF-8?B?` and `?=` take 12 of the 75 characters, which leaves 60 base64 characters
  // for 45 bytes.
  const maxBytes = 45;
  const words: string[] = [];
  let word = '';
  for (const character of text) {
    if (word !== '' && Buffer.byteLength(word + character) > maxBytes) {
      words.push(word);
      word = '';
    }
    word += character;
  }
  if (word !== '') {
    words.push(word);
  }
  return words.map(chunk => `=?UTF-8?B?${Buffer.from(chunk, 'utf8').toString('base64')}?=`);
}

/**
 * Encode an unstructured header value, such as a subject: unchanged when it is printable
 * ASCII, otherwise as RFC 2047 encoded words folded onto continuation lines. Mail clients
 * show a raw UTF-8 header as mojibake, and servers may reject it (RFC 5322 headers are
 * ASCII).
 */
export function encodeHeaderText(value: string): string {
  const text = sanitizeHeaderValue(value);
  return PRINTABLE_ASCII.test(text) ? text : encodedWords(text).join('\n ');
}

/**
 * Format an address for a From, To or similar header: the bare address, or
 * `name <address>` with the display name as an RFC 5322 phrase. A name of plain words is
 * written as is; one with special characters is quoted, as a comma would otherwise split
 * the address list and `<` or `@` would change the address; a name that is not ASCII is
 * written as encoded words.
 */
export function formatAddress({name, email}: {name?: string; email: string}): string {
  const address = sanitizeHeaderValue(email).trim();
  const phrase = sanitizeHeaderValue(name ?? '').trim();
  if (phrase === '') {
    return address;
  }
  if (!PRINTABLE_ASCII.test(phrase)) {
    return `${encodedWords(phrase).join(' ')} <${address}>`;
  }
  // RFC 5322 atext, and the spaces between words.
  if (/^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~ ]+$/.test(phrase)) {
    return `${phrase} <${address}>`;
  }
  return `"${phrase.replace(/(["\\])/g, '\\$1')}" <${address}>`;
}

/**
 * The file name parameters of a Content-Disposition header. A printable ASCII name is a
 * quoted `filename`; any other name adds an RFC 2231 `filename*` in UTF-8, which clients
 * prefer, next to an ASCII `filename` for those that do not read it.
 */
export function filenameParameters(filename: string): string {
  const name = sanitizeHeaderValue(filename);
  const ascii = `filename="${name.replace(/[^\x20-\x7e]/g, '_').replace(/(["\\])/g, '\\$1')}"`;
  if (PRINTABLE_ASCII.test(name)) {
    return ascii;
  }
  // RFC 5987 attr-chars stay literal; `encodeURIComponent` leaves four other characters
  // unescaped, which have to be escaped too.
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${ascii}; filename*=UTF-8''${encoded}`;
}
