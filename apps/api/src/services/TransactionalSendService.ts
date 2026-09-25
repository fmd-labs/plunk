import {EmailSourceType, EmailStatus, type Template, type TemplateType} from '@plunk/db';
import type {ActionSchemas} from '@plunk/shared';
import signale from 'signale';
import type {z} from 'zod';

import {DASHBOARD_URI} from '../app/constants.js';
import {prisma} from '../database/prisma.js';
import {ErrorCode, type FieldError, HttpException, NotFound, ValidationError} from '../exceptions/index.js';
import {claimKey} from '../middleware/idempotency.js';
import {isUniqueViolation} from '../utils/prismaErrors.js';
import {uuidv5} from '../utils/uuid.js';
import {ContactService} from './ContactService.js';
import {DomainService} from './DomainService.js';
import {PRIORITY_HEADER, TEMPLATING_HEADER} from './EmailHeaderService.js';
import {EmailNotQueuedError, EmailService} from './EmailService.js';
import {QueueService, type SendPriority, storedPriority} from './QueueService.js';

/** A `POST /v1/send` request body, as `ActionSchemas.send` parses it. */
export type SendRequest = z.infer<typeof ActionSchemas.send>;

export interface SendRecipient {
  email: string;
  name?: string;
}

/**
 * A send request resolved against its project: the recipients, and the sender and content each of
 * them gets. The subject and body are not rendered yet; the placeholders are filled in per
 * recipient.
 */
export interface PreparedSend {
  projectId: string;
  recipients: SendRecipient[];
  subject: string;
  body: string;
  from: string;
  fromName?: string;
  replyTo?: string;
  templateId?: string;
  /** The type of `templateId`, which decides whether the recipient must be subscribed. */
  templateType?: TemplateType;
  data?: Record<string, unknown>;
  subscribed?: boolean;
  headers?: SendRequest['headers'];
  attachments?: SendRequest['attachments'];
  /** False: the subject and body are sent as they are, placeholders and all. */
  templating: boolean;
  /** The queue priority the sender asked for; the transactional default when unset. */
  priority?: SendPriority;
}

/** Why an email of a batch was not sent, and whether sending it again later may work. */
export interface BatchEmailError {
  code: string;
  message: string;
  retryable: boolean;
}

/** The outcome for one email of a `POST /v1/send/batch` request. */
export type BatchEmailResult =
  | ({status: 'queued' | 'duplicate'} & QueuedEmail)
  | {status: 'failed'; error: BatchEmailError};

/**
 * The error code of a refusal of an email of a batch, where no HTTP status tells refusals apart.
 * Some refusals of the send path carry no code of their own; within a batch, a `429` is the
 * billing limit, as the rate limit applies to the whole request.
 */
function batchErrorCode(error: HttpException): string {
  if (error.errorCode) {
    return error.errorCode;
  }
  if (error.code >= 500) {
    return ErrorCode.INTERNAL_SERVER_ERROR;
  }
  switch (error.code) {
    case 429:
      return ErrorCode.BILLING_LIMIT_EXCEEDED;
    case 403:
      return ErrorCode.FORBIDDEN;
    case 404:
      return ErrorCode.RESOURCE_NOT_FOUND;
    default:
      return ErrorCode.BAD_REQUEST;
  }
}

function batchError(error: unknown): BatchEmailError {
  const status = error instanceof HttpException ? error.code : 500;
  return {
    code: error instanceof HttpException ? batchErrorCode(error) : ErrorCode.INTERNAL_SERVER_ERROR,
    // The message of a failure on Plunk's side is Plunk's own business: it can carry a database error.
    message: error instanceof HttpException && status < 500 ? error.message : 'The email could not be sent',
    // A limit that lifts, or a failure on Plunk's side.
    retryable: status === 429 || status >= 500,
  };
}

/** An email created and queued for one recipient, as `POST /v1/send` reports it. */
export interface QueuedEmail {
  contact: {id: string; email: string};
  email: string;
}

/** The namespace of the email ids derived from an idempotency claim (see `emailIds` and `sendBatchItem`). */
const CLAIMED_EMAIL_NAMESPACE = '3d32fa1c-25fe-4376-bf2f-11b83f558336';

/**
 * How many emails of a batch are sent at once. Each takes a dozen database and Redis round trips
 * (claim, contact, billing check, email, job), which a batch of 100 would otherwise wait out one
 * after another.
 */
const BATCH_CONCURRENCY = 10;

/**
 * Lookups the emails of one batch share while they are prepared: a template, and the check of a
 * sender's domain, by the template id and the sender's address. A failed check is shared too.
 */
interface PrepareCache {
  templates: Map<string, Promise<Template | null>>;
  domains: Map<string, Promise<unknown>>;
}

function cached<T>(cache: Map<string, Promise<T>> | undefined, key: string, load: () => Promise<T>): Promise<T> {
  if (!cache) {
    return load();
  }
  let entry = cache.get(key);
  if (!entry) {
    entry = load();
    cache.set(key, entry);
  }
  return entry;
}

/**
 * Transactional sends: what `POST /v1/send` does once its request is authenticated and parsed.
 */
export class TransactionalSendService {
  /** The recipients of a request, in order: `to` as a list of addresses with optional names. */
  public static recipientsOf(to: SendRequest['to']): SendRecipient[] {
    // Normalize recipients to array and parse email/name
    return (Array.isArray(to) ? to : [to]).map(recipient => {
      if (typeof recipient === 'string') {
        return {email: recipient};
      } else {
        return {email: recipient.email, name: recipient.name};
      }
    });
  }

  /**
   * The ids of the emails a request working under an idempotency claim creates, one per recipient.
   * Each derives from the claim, the recipient's address and how often that address came earlier in
   * the request, so a retry of the request arrives at the same emails, however it orders them.
   */
  public static emailIds(claimId: string, recipients: SendRecipient[]): string[] {
    const earlier = new Map<string, number>();
    return recipients.map(({email}) => {
      const address = ContactService.normalizeEmail(email);
      const occurrence = earlier.get(address) ?? 0;
      earlier.set(address, occurrence + 1);
      return uuidv5(`${claimId}:${address}:${occurrence}`, CLAIMED_EMAIL_NAMESPACE);
    });
  }

  /** The emails requests under this claim have created so far for the request's recipients, in its order. */
  public static async findQueued(projectId: string, request: SendRequest, claimId: string): Promise<QueuedEmail[]> {
    const ids = this.emailIds(claimId, this.recipientsOf(request.to));
    const emails = await prisma.email.findMany({
      where: {id: {in: ids}, projectId},
      select: {id: true, contact: {select: {id: true, email: true}}},
    });

    const byId = new Map(emails.map(email => [email.id, email]));
    return ids.flatMap(id => {
      const email = byId.get(id);
      return email ? [{contact: email.contact, email: email.id}] : [];
    });
  }

  /**
   * Resolve a send request against its project: normalize the recipients, take the sender and
   * content from the request and its template, and check the sender's domain. Every refusal it
   * raises comes before anything is written.
   *
   * Inline subject/body are templates too, but they are deliberately NOT syntax
   * checked here. Transactional bodies are generated by whatever system calls us —
   * Handlebars output, front-end framework markup, an unbalanced `{{` in a code
   * sample — and those sent fine before Liquid existed. Rejecting them now would
   * break live integrations over markup the renderer already handles by falling back
   * to plain placeholder substitution. Authoring-time surfaces (templates, campaigns)
   * are where a syntax error is worth failing the write.
   */
  public static async prepare(projectId: string, request: SendRequest, cache?: PrepareCache): Promise<PreparedSend> {
    const {to, subject, body, subscribed, name, from, reply, headers, data, template, attachments} = request;

    const recipients = this.recipientsOf(to);

    // Parse 'from' field - can be string or object {name, email}
    let emailFrom: string | undefined;
    let emailFromName: string | undefined;

    if (typeof from === 'string') {
      // Backward compatible: from is just an email string
      emailFrom = from;
      emailFromName = name; // Use separate 'name' field if provided
    } else if (from && typeof from === 'object') {
      // New format: from is an object with {name, email}
      emailFrom = from.email;
      emailFromName = from.name || name; // Prefer from.name, fallback to separate 'name' field
    } else {
      // No 'from' provided
      emailFromName = name;
    }

    // Fetch template if provided
    let emailSubject = subject;
    let emailBody = body;
    let emailReplyTo = reply;
    let templateId: string | undefined;
    let templateType: TemplateType | undefined;

    if (template) {
      const templateRecord = await cached(cache?.templates, template, () =>
        prisma.template.findUnique({
          where: {
            id: template,
            projectId, // Ensure template belongs to this project
          },
        }),
      );

      if (!templateRecord) {
        throw new NotFound('Template', template);
      }

      // Use template values, allow overrides from request
      emailSubject = subject || templateRecord.subject;
      emailBody = body || templateRecord.body;

      // Handle from field - if not already set and template has a from, use it
      if (!emailFrom && templateRecord.from) {
        emailFrom = templateRecord.from;
      }
      if (!emailFromName && templateRecord.fromName) {
        emailFromName = templateRecord.fromName;
      }

      emailReplyTo = reply || templateRecord.replyTo || undefined;
      templateId = templateRecord.id;
      templateType = templateRecord.type;
    }

    if (!emailFrom) {
      throw new ValidationError(
        [
          {
            field: 'from',
            message: 'Sender email is required either in request or template',
            code: 'required',
          },
        ],
        'Could not parse sender email',
      );
    }

    const sender = emailFrom;
    await cached(cache?.domains, sender, () => DomainService.verifyEmailDomain(sender, projectId));

    return {
      projectId,
      recipients,
      // The schema requires both unless a template supplies them.
      subject: emailSubject!,
      body: emailBody!,
      from: emailFrom,
      fromName: emailFromName,
      replyTo: emailReplyTo,
      templateId,
      templateType,
      data: data as Record<string, unknown> | undefined,
      subscribed,
      headers,
      attachments,
      templating: request.templating !== false,
      priority: request.priority,
    };
  }

  /**
   * Send a prepared email to one recipient: create or update the contact, fill in the
   * placeholders, then create and queue the email. Given an `emailId` that an email already has,
   * that email is the recipient's, and nothing is written.
   */
  public static async sendTo(send: PreparedSend, recipient: SendRecipient, emailId?: string): Promise<QueuedEmail> {
    const {email, notQueued} = await this.createOrFind(send, recipient, emailId);
    // The request fails, and a retry with its key queues the email (or the stalled-email sweep does).
    if (notQueued) {
      throw notQueued.cause;
    }
    return email;
  }

  /**
   * {@link sendTo}, telling whether it created the email or found it, and returning an email it
   * created under `emailId` but could not queue (`notQueued`) rather than throwing.
   */
  private static async createOrFind(
    send: PreparedSend,
    recipient: SendRecipient,
    emailId?: string,
  ): Promise<{email: QueuedEmail; created: boolean; notQueued?: EmailNotQueuedError}> {
    if (emailId) {
      const existing = await this.findClaimedEmail(send.projectId, emailId);
      if (existing) {
        return {email: existing, created: false};
      }
    }

    // Merge recipient name with data if provided
    const recipientData = recipient.name ? {...send.data, name: recipient.name} : send.data;

    // Create or update contact with metadata
    // Transactional emails should not subscribe contacts by default
    // New contacts default to unsubscribed unless explicitly opted in
    // Existing contacts preserve their subscription state unless explicitly changed
    const contact = await ContactService.upsert(send.projectId, recipient.email, recipientData, send.subscribed, false);

    // Get merged data including non-persistent fields for template rendering
    const mergedData = ContactService.getMergedData(contact, send.data);

    // Add system variables (email, unsubscribe URLs, etc.) to merged data
    // These are always available for template rendering
    const dataWithSystemVars = {
      ...mergedData,
      id: contact.id,
      email: contact.email,
      data: mergedData, // Also available as nested data for {{data.fieldName}} syntax
      unsubscribeUrl: `${DASHBOARD_URI}/unsubscribe/${contact.id}`,
      subscribeUrl: `${DASHBOARD_URI}/subscribe/${contact.id}`,
      manageUrl: `${DASHBOARD_URI}/manage/${contact.id}`,
    };

    try {
      const email = await EmailService.sendTransactionalEmail({
        id: emailId,
        projectId: send.projectId,
        contactId: contact.id,
        subject: send.templating ? this.renderPlaceholders(send.subject, dataWithSystemVars) : send.subject,
        body: send.templating ? this.renderPlaceholders(send.body, dataWithSystemVars) : send.body,
        from: send.from,
        fromName: send.fromName,
        toName: recipient.name,
        replyTo: send.replyTo,
        headers: this.storedHeaders(send),
        attachments: send.attachments || undefined,
        templateId: send.templateId,
        templateType: send.templateType,
        priority: send.priority,
      });

      return {
        email: {
          contact: {
            id: contact.id,
            email: contact.email,
          },
          email: email.id,
        },
        created: true,
      };
    } catch (error) {
      if (error instanceof EmailNotQueuedError) {
        return {
          email: {contact: {id: contact.id, email: contact.email}, email: error.email.id},
          created: true,
          notQueued: error,
        };
      }
      // A concurrent request under the same claim created the email first.
      const existing =
        emailId && isUniqueViolation(error) ? await this.findClaimedEmail(send.projectId, emailId) : null;
      if (existing) {
        return {email: existing, created: false};
      }
      throw error;
    }
  }

  /**
   * Send a prepared email to each of its recipients, in order. Under an idempotency claim, each
   * recipient's email gets the id `emailIds` derives, so a retry finds the emails already created.
   */
  public static async sendToAll(send: PreparedSend, claimId?: string): Promise<QueuedEmail[]> {
    const ids = claimId ? this.emailIds(claimId, send.recipients) : [];
    const emails: QueuedEmail[] = [];
    for (const [index, recipient] of send.recipients.entries()) {
      emails.push(await this.sendTo(send, recipient, ids[index]));
    }
    return emails;
  }

  /**
   * Prepare every email of a batch before any is sent, so that a refusal (an unknown template, a
   * sender domain that is not verified, a missing sender) fails the whole request with nothing
   * written. Each refusal names its email as `emails.<index>`.
   */
  public static async prepareBatch(projectId: string, requests: SendRequest[]): Promise<PreparedSend[]> {
    const prepared: PreparedSend[] = [];
    const errors: FieldError[] = [];
    // The emails of a batch mostly share a template and a sender: each is read and checked once.
    const cache: PrepareCache = {templates: new Map(), domains: new Map()};
    for (const [index, request] of requests.entries()) {
      try {
        prepared.push(await this.prepare(projectId, request, cache));
      } catch (error) {
        if (!(error instanceof HttpException)) {
          throw error;
        }
        const refusals =
          error instanceof ValidationError
            ? error.errors
            : [{field: '', message: error.message, code: batchErrorCode(error)}];
        for (const refusal of refusals) {
          errors.push({...refusal, field: [`emails.${index}`, refusal.field].filter(Boolean).join('.')});
        }
      }
    }
    if (errors.length > 0) {
      throw new ValidationError(errors, 'Some emails of the batch cannot be sent');
    }
    return prepared;
  }

  /**
   * Send the prepared emails of a batch, `BATCH_CONCURRENCY` at a time, with `keys[index]` as the
   * idempotency key of `sends[index]`. The emails to one address go one after another, in the order
   * of the batch: they write the same contact, whose data the later one sets last. The results
   * come in the order of the batch.
   */
  public static async sendBatch(sends: PreparedSend[], keys: (string | undefined)[]): Promise<BatchEmailResult[]> {
    const byAddress = new Map<string, number[]>();
    for (const [index, send] of sends.entries()) {
      const address = ContactService.normalizeEmail(send.recipients[0]!.email);
      byAddress.set(address, [...(byAddress.get(address) ?? []), index]);
    }

    const results: BatchEmailResult[] = new Array(sends.length);
    const pending = [...byAddress.values()];
    const sender = async () => {
      for (let group = pending.shift(); group; group = pending.shift()) {
        for (const index of group) {
          results[index] = await this.sendBatchItem(sends[index]!, keys[index]);
        }
      }
    };
    await Promise.all(Array.from({length: Math.min(BATCH_CONCURRENCY, pending.length)}, sender));
    return results;
  }

  /**
   * Send one prepared email of a batch, to its single recipient. With an idempotency key, the email
   * is created under an id derived from the key's claim alone, so an email an earlier batch sent with
   * the same key is reported as a duplicate rather than sent again, whoever it was to. A failure is
   * reported rather than thrown, so that the rest of the batch goes on.
   */
  public static async sendBatchItem(send: PreparedSend, idempotencyKey?: string): Promise<BatchEmailResult> {
    const recipient = send.recipients[0]!;
    try {
      // A key names one email, whoever it is to: an email a batch with the same key created is a
      // duplicate even when this one names another recipient.
      const emailId = idempotencyKey
        ? uuidv5(await this.batchClaim(send.projectId, idempotencyKey), CLAIMED_EMAIL_NAMESPACE)
        : undefined;
      const {email, created, notQueued} = await this.createOrFind(send, recipient, emailId);
      if (notQueued) {
        // Saved under its key, so it is sent: by the stalled-email sweep within about 20 minutes,
        // or at once when a retry with the key queues it. Reporting it as failed would invite a
        // send under another key or provider, which would reach the recipient twice.
        signale.warn(
          `[SEND-BATCH] Email ${email.email} could not be queued; it is sent once queued again:`,
          notQueued.cause,
        );
      }
      return {status: created ? 'queued' : 'duplicate', ...email};
    } catch (error) {
      signale.warn('[SEND-BATCH] Failed to send an email of a batch:', error);
      return {status: 'failed', error: batchError(error)};
    }
  }

  /** The claim of a batch email's idempotency key, which the email's id derives from. */
  private static async batchClaim(projectId: string, key: string): Promise<string> {
    // Kept apart from Idempotency-Key headers, which cannot hold the separator.
    const batchKey = `send-batch-item\x1f${key}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      const claim = await claimKey(projectId, batchKey, 'POST', '/v1/send/batch');
      const claimId = claim.claimId ?? claim.reused?.id;
      if (claimId) {
        return claimId;
      }
      // The earlier claim expired and was removed in the meantime: claim the key anew.
    }
    throw new Error('Could not claim the idempotency key');
  }

  /**
   * An email a request under the same claim already created. It is queued again while it waits to
   * be sent, in case that request died between creating and queueing it; the queue ignores a job it
   * already holds.
   */
  private static async findClaimedEmail(projectId: string, id: string): Promise<QueuedEmail | null> {
    const email = await prisma.email.findFirst({
      where: {id, projectId},
      select: {id: true, status: true, headers: true, contact: {select: {id: true, email: true}}},
    });

    if (!email) {
      return null;
    }

    if (email.status === EmailStatus.PENDING) {
      await QueueService.queueEmail(email.id, EmailSourceType.TRANSACTIONAL, undefined, storedPriority(email.headers));
    }

    return {contact: email.contact, email: email.id};
  }

  /**
   * The headers stored on each email of a send: the caller's, and Plunk's own for what the worker
   * and a later re-queue have to know (templating off, the priority asked for).
   */
  private static storedHeaders(send: PreparedSend): Record<string, string> | undefined {
    const internal: Record<string, string> = {};
    if (!send.templating) {
      internal[TEMPLATING_HEADER] = 'off';
    }
    if (send.priority) {
      internal[PRIORITY_HEADER] = send.priority;
    }
    return Object.keys(internal).length > 0 ? {...send.headers, ...internal} : send.headers || undefined;
  }

  /**
   * Simple template variable replacement: `{{fieldname}}`, and `{{fieldname ?? fallback}}` for a
   * value that is missing or empty. Placeholders without a value are removed.
   */
  private static renderPlaceholders(text: string, variables: Record<string, unknown>): string {
    let rendered = text;

    for (const [key, value] of Object.entries(variables)) {
      // A key is data the caller chose, so it matches literally: `a(b` must not break the pattern.
      const name = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const placeholder = new RegExp(`\\{\\{\\s*${name}\\s*\\}\\}`, 'g');
      const fallbackPlaceholder = new RegExp(`\\{\\{\\s*${name}\\s*\\?\\?\\s*([^}]+)\\}\\}`, 'g');

      // Replace with value, literally: a `$1` or `$&` in a value is text, not a replacement pattern
      const stringValue = value !== null && value !== undefined ? String(value) : '';
      rendered = rendered.replace(placeholder, () => stringValue);

      // Handle fallback syntax: {{field ?? default}}
      rendered = rendered.replace(fallbackPlaceholder, (_match, fallback: string) => stringValue || fallback);
    }

    // Replace any remaining placeholders with empty string or fallback value
    rendered = rendered.replace(/\{\{\s*(\w+)\s*\}\}/g, '');

    // Handle fallback placeholders that weren't matched
    return rendered.replace(/\{\{\s*\w+\s*\?\?\s*([^}]+)\}\}/g, '$1');
  }
}
