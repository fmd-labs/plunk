import type {Contact, Layout, Project} from '@plunk/db';

import {bodyHasListManagementLink, buildEmailHeaders, type EmailClass} from './EmailHeaderService.js';
import {EmailService} from './EmailService.js';
import {hasVisibleUnsubscribeLink, inlineLayoutCss, layoutReplacesFooter} from './LayoutService.js';
import type {ListManagementUrls} from './ListManagementUrls.js';

/**
 * The last steps of an email before it is handed to SES, shared by the worker and the rendered test
 * send (fork D35), so that a test shows exactly what recipients get: the layout's CSS inlined (D34),
 * Plunk's wrapper, footer and badge, and the standard headers.
 */
export interface AssembleEmailParams {
  /** The rendered body, in its layout when it has one. */
  body: string;
  contact: Pick<Contact, 'id' | 'data'>;
  project: Project;
  emailClass: EmailClass;
  /** Part of a campaign broadcast, which marks it as bulk mail. */
  isCampaign: boolean;
  /** The email's id, which the list-management links name for attribution. */
  emailId?: string;
  /** The email's list-management URLs (D33); `null` when the project's template rendered none. */
  links: ListManagementUrls | null;
  /** The layout the body was composed in (D34). */
  layout: Pick<Layout, 'html' | 'css'> | null;
  /** Headers to send as they are (the caller's, never Plunk's internal ones); they override the defaults. */
  headers?: Record<string, string>;
}

export function assembleEmail({
  body,
  contact,
  project,
  emailClass,
  isCampaign,
  emailId,
  links,
  layout,
  headers,
}: AssembleEmailParams): {html: string; headers: Record<string, string>} {
  // D34: a layout's CSS is inlined, and a layout that links to the recipient's unsubscribe page
  // replaces Plunk's footer, once the rendered email shows that link where every client shows it.
  const content = layout ? inlineLayoutCss(body, layout.css) : body;
  const templateUnsubscribeUrl = project.unsubscribeUrlTemplate ? links?.unsubscribeUrl : undefined;
  const layoutFooter =
    !!layout && layoutReplacesFooter(layout) && hasVisibleUnsubscribeLink(content, contact.id, templateUnsubscribeUrl);

  // Compile HTML with unsubscribe footer and badge.
  // Only marketing emails get the Plunk unsubscribe footer.
  const html = EmailService.compile({
    content,
    contact,
    project,
    includeUnsubscribe: emailClass === 'marketing' && !layoutFooter,
    sourceEmailId: emailId,
    unsubscribeUrl: templateUnsubscribeUrl,
  });

  // Build the outbound headers: standards-based defaults for the email class
  // plus any caller-supplied headers (which override the defaults).
  const outboundHeaders = buildEmailHeaders({
    emailClass,
    isCampaign,
    hasListManagementLink: bodyHasListManagementLink(html, contact.id, templateUnsubscribeUrl),
    // Without a URL from the project's template, no List-Unsubscribe pair: a transactional email whose
    // body has a link the template left empty.
    unsubscribeId: links ? contact.id : undefined,
    sourceEmailId: emailId,
    oneClickUrl: project.unsubscribeUrlTemplate ? links?.oneClickUrl : undefined,
    customHeaders: headers,
  });

  return {html, headers: outboundHeaders};
}
