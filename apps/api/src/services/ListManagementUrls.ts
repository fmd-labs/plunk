import type {Topic} from '@plunk/db';
import {compileTemplate} from '@plunk/shared';

import {API_URI, DASHBOARD_URI} from '../app/constants.js';
import {withSourceEmail} from './EmailHeaderService.js';

/**
 * Where an email's list-management links point (fork D33).
 *
 * By default they are Plunk's own: the hosted unsubscribe, subscribe and manage pages, and the
 * one-click endpoint for `List-Unsubscribe`. A project can set an unsubscribe URL template instead,
 * a Liquid template that renders the sender's own page for each email. That one URL then serves
 * every link: `{{ unsubscribeUrl }}`, `{{ subscribeUrl }}`, `{{ manageUrl }}`, the footer and
 * `List-Unsubscribe` / `List-Unsubscribe-Post`, so it has to act on a bare POST (RFC 8058) as well
 * as show a page on a GET.
 */

/** The topic of an email's campaign, as the URL template sees it. */
export type UrlTopic = Pick<Topic, 'id' | 'slug' | 'name'>;

export interface ListManagementUrls {
  unsubscribeUrl: string;
  subscribeUrl: string;
  manageUrl: string;
  /** The `List-Unsubscribe` target, which acts on a bare POST. */
  oneClickUrl: string;
}

export interface ListManagementUrlParams {
  contact: {id: string; email: string; data?: unknown};
  /** The email the links are rendered into; absent outside of an email (workflow webhooks). */
  emailId?: string;
  /** The project's unsubscribe URL template; Plunk's own pages without one. */
  template?: string | null;
  /** The topic of the email's campaign, in a project with topics. */
  topic?: UrlTopic | null;
}

/**
 * The longest URL taken. `List-Unsubscribe` is written on one line, which RFC 5322 caps at 998
 * characters, name and angle brackets included.
 */
export const MAX_UNSUBSCRIBE_URL_LENGTH = 900;

/** A hostname (letters, digits, `-` and `.`, as the URL parser lowercases and punycodes it) or an IP literal. */
const PLAIN_HOST = /^(?:[a-z0-9-]+\.)*[a-z0-9-]+$|^\[[0-9a-f:.]+\]$/;

/**
 * An email's list-management URLs, or `null` when the project's template renders no http(s) URL
 * for it (a value the template reads is missing, say). A marketing email must not go out then,
 * since its recipient would have no working way out; see the email processor.
 */
export function listManagementUrls({contact, emailId, template, topic}: ListManagementUrlParams): ListManagementUrls | null {
  if (!template) {
    return {
      unsubscribeUrl: withSourceEmail(`${DASHBOARD_URI}/unsubscribe/${contact.id}`, emailId),
      subscribeUrl: withSourceEmail(`${DASHBOARD_URI}/subscribe/${contact.id}`, emailId),
      manageUrl: withSourceEmail(`${DASHBOARD_URI}/manage/${contact.id}`, emailId),
      oneClickUrl: withSourceEmail(`${API_URI}/unsubscribe/${contact.id}`, emailId),
    };
  }

  const url = renderUnsubscribeUrl(template, {contact, emailId, topic});
  return url ? {unsubscribeUrl: url, subscribeUrl: url, manageUrl: url, oneClickUrl: url} : null;
}

/**
 * Render the template for one email. The scope is an email's (the contact's stored data, at the
 * top level and as `data`, `id` and `email`) plus `emailId` and `topic` (`id`, `slug`, `name`; `null`
 * for an email that has none). Request-only data of a `/v1/send` is not in it: the links rendered into
 * the body, the footer and the header are rendered at different times and must all agree.
 *
 * Nothing is escaped: values that belong in a query string are the template's to encode
 * (`{{ value | url_encode }}`). See {@link normalizeHttpUrl} for what the result may hold.
 */
function renderUnsubscribeUrl(
  template: string,
  {contact, emailId, topic}: Omit<ListManagementUrlParams, 'template'>,
): string | null {
  const data =
    contact.data && typeof contact.data === 'object' && !Array.isArray(contact.data)
      ? (contact.data as Record<string, unknown>)
      : {};

  const rendered = compileTemplate(template)
    .render({
      ...data,
      id: contact.id,
      email: contact.email,
      data,
      emailId: emailId ?? null,
      topic: topic ? {id: topic.id, slug: topic.slug, name: topic.name} : null,
    })
    .trim();

  return normalizeHttpUrl(rendered);
}

/** The links as template variables: `unsubscribeUrl`, `subscribeUrl` and `manageUrl`, empty without URLs. */
export function linkVariables(urls: ListManagementUrls | null): {
  unsubscribeUrl: string;
  subscribeUrl: string;
  manageUrl: string;
} {
  return {
    unsubscribeUrl: urls?.unsubscribeUrl ?? '',
    subscribeUrl: urls?.subscribeUrl ?? '',
    manageUrl: urls?.manageUrl ?? '',
  };
}

/**
 * The URL parser's form of an absolute http(s) URL with a plain host, or `null` for anything else.
 * The parser drops line breaks and tabs and percent-encodes spaces, double quotes and angle brackets
 * outside the host; a host must be a plain hostname or IP literal (the parser keeps a quote there),
 * and single quotes are encoded too. So the URL fits in a header as it is, and in a quoted HTML
 * attribute once `&` is escaped.
 */
export function normalizeHttpUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || !PLAIN_HOST.test(url.hostname)) {
    return null;
  }

  const href = url.href.replaceAll("'", '%27');
  return href.length <= MAX_UNSUBSCRIBE_URL_LENGTH ? href : null;
}
