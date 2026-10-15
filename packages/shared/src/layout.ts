/**
 * Layouts (fork D34): an HTML document with one `{{ content }}` slot that a template's or campaign's
 * body is sent in. The slot is filled with the body's source before the email's one template pass
 * (D28), so the layout and the body render together, with the same variables, and contact data is
 * never read as template code.
 */

/** The slot, `{{ content }}`, with Liquid's optional whitespace control (`{{- content -}}`). */
const SLOT = /\{\{-?\s*content\s*-?\}\}/g;

/** A link a recipient can opt out with: `{{ unsubscribeUrl }}` or `{{ manageUrl }}`, filters allowed. */
const LIST_MANAGEMENT_LINK = /\{\{-?\s*(?:unsubscribeUrl|manageUrl)\b/;

/** How many `{{ content }}` slots the layout has; a layout must have exactly one. */
export function layoutSlotCount(html: string): number {
  return html.match(SLOT)?.length ?? 0;
}

/** The layout with its slot filled with the body. */
export function applyLayout(html: string, content: string): string {
  // A function replacement, so `$&` and the like in the body stay as written.
  return html.replace(SLOT, () => content);
}

/**
 * Whether the layout links to the recipient's unsubscribe or preferences page itself. Such a layout
 * replaces Plunk's marketing footer.
 */
export function layoutHasUnsubscribeLink(html: string): boolean {
  return LIST_MANAGEMENT_LINK.test(html);
}

/**
 * The editor's button (`a.email-button`) as Plunk's own wrapper styles it. Sends put it ahead of the
 * layout's CSS, so that a layout can restyle the button, and one that does not mention it still sends
 * a button rather than a plain link.
 */
export const LAYOUT_BUTTON_CSS =
  '.email-button-row{margin:24px 0}' +
  'a.email-button{display:inline-block;padding:12px 20px;border-radius:6px;background-color:#171717;' +
  'color:#ffffff;font-weight:600;text-decoration:none}';

/**
 * The document with the CSS in a `<style>` block: at the start of its head, else right after its `<html>`
 * tag, else at its start.
 */
export function withStyleBlock(html: string, css: string): string {
  const block = `<style>${css}</style>`;
  const tag = /<head(?=[\s>])[^>]*>/i.exec(html) ?? /<html(?=[\s>])[^>]*>/i.exec(html);
  if (tag) {
    const at = tag.index + tag[0].length;
    return html.slice(0, at) + block + html.slice(at);
  }
  return block + html;
}
