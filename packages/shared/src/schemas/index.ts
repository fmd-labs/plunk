import {CampaignAudienceType, TemplateType, TrackingMode, WorkflowStepType, WorkflowTriggerType} from '@plunk/db';
import type {FilterCondition, FilterGroup} from '@plunk/types';
import {SNOOZE_DURATIONS} from '@plunk/types';
import {z} from 'zod';

import {layoutSlotCount} from '../layout.js';
import {MAX_SENDS_PER_HOUR} from '../pacing.js';
import {API_KEY_SCOPES} from '../apiKeys.js';

const literalSchema = z.union([z.string(), z.number(), z.boolean(), z.null(), z.date()]);
type Literal = z.infer<typeof literalSchema>;
type Json = Literal | {[key: string]: Json} | Json[];
const jsonSchema: z.ZodType<Json> = z.lazy(() => z.union([literalSchema, z.array(jsonSchema), z.record(jsonSchema)]));

const uuid = z.string().uuid();
const email = z.string().email();

export const UtilitySchemas = {
  id: z.object({
    id: uuid,
  }),
  email: z.object({
    email,
  }),
  pagination: z.object({
    page: z
      .union([z.number(), z.string()])
      .transform(value => parseInt(value as string, 10))
      .nullish()
      .transform(value => value ?? 1),
    limit: z
      .union([z.number(), z.string()])
      .transform(value => parseInt(value as string, 10))
      .nullish()
      .transform(value => value ?? 20),
    sort: z.enum(['alphabetical', 'latest']).default('latest'),
  }),
  query: z.object({
    query: z.string().min(3),
    filters: z
      .union([z.array(z.string()), z.string()])
      .transform(value => (Array.isArray(value) ? value : value.split('_').filter(Boolean)))
      .optional()
      .default([]),
  }),
} as const;

export const AuthenticationSchemas = {
  login: z.object({
    email,
    password: z.string().min(6),
  }),
  signup: z.object({
    email,
    password: z.string().min(6),
  }),
  verifyEmail: z.object({
    token: z.string().length(64, 'Invalid verification token'),
  }),
  requestPasswordReset: z.object({
    email,
  }),
  resetPassword: z.object({
    token: z.string().length(64, 'Invalid reset token'),
    newPassword: z.string().min(6, 'Password must be at least 6 characters'),
  }),
} as const;

export const UserSchemas = {
  changePassword: z.object({
    currentPassword: z.string().min(1, 'Enter your current password'),
    newPassword: z.string().min(6, 'Password must be at least 6 characters'),
  }),
} as const;

// Zero-width / bidi / formatting characters that render invisibly and aren't normalized away by NFKC.
const invisibleCharRegex =
  /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\u3164\uFEFF\uFFA0]/u;

const projectName = z
  .string()
  .min(1)
  .max(100)
  .refine(val => !invisibleCharRegex.test(val), {
    message: 'Name contains invisible or formatting characters',
  })
  .refine(val => val.normalize('NFC') === val.normalize('NFKC'), {
    message: 'Name contains decorative or look-alike characters. Use plain letters and numbers.',
  });

/** Whether a value is an absolute http(s) URL with a host (`https:example.com` parses, but browsers resolve it). */
const isHttpUrl = (value: string) => {
  if (!/^https?:\/\/[^/\s]/i.test(value)) {
    return false;
  }
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
};

export const ProjectSchemas = {
  create: z.object({
    name: projectName,
  }),
  update: z.object({
    name: projectName.optional(),
    tracking: z.nativeEnum(TrackingMode).optional(),
    language: z
      .string()
      .regex(/^[a-z]{2}(-[A-Z]{2})?$/)
      .optional(),
    // HTML-escape template variables in email bodies (fork D29).
    escapeVariables: z.boolean().optional(),
    // Send campaigns per topic (fork D32).
    topicsEnabled: z.boolean().optional(),
    // Contacts that transactional sends create start subscribed (fork D32).
    subscribeTransactionalContacts: z.boolean().optional(),
    // The sender's own unsubscribe page, a Liquid template (fork D33); empty for Plunk's pages.
    unsubscribeUrlTemplate: z
      .string()
      .trim()
      .max(2000)
      .nullish()
      .transform(value => (value ? value : value === undefined ? undefined : null)),
    // The project's avatar (fork D38): an image URL, an upload's or any other; empty removes it.
    avatarUrl: z
      .string()
      .trim()
      .max(2048)
      .refine(value => value === '' || isHttpUrl(value), 'Use an http(s):// image URL')
      .nullish()
      // Stored as the browser reads it: spaces and the like encoded.
      .transform(value => (value ? new URL(value).href : value === undefined ? undefined : null)),
  }),
} as const;

/** A topic's slug (fork D32): lowercase letters, digits, `_` and `-`, starting with a letter or digit. */
const topicSlug = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'Use lowercase letters, digits, "_" and "-"');

/** Explicit topic states by slug (fork D32): `true` subscribes, `false` unsubscribes, `null` lets the basis decide. */
const topicStates = z.record(topicSlug, z.boolean().nullable());

export const TopicSchemas = {
  slug: topicSlug,
  upsert: z.object({
    name: z.string().min(1).max(100),
    description: z.string().max(500).nullish(),
    basis: z.enum(['OPT_IN', 'OPT_OUT']).optional(),
    campaignSelectable: z.boolean().optional(),
    // RFC 2919: an optional phrase, then the list's id in angle brackets, a dotted atom such as
    // `news.example.com`. Printable ASCII only, since the header is written as it is.
    listId: z
      .string()
      .max(255)
      .regex(
        /^[\x20-\x3B\x3D\x3F-\x7E]*<[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)+>$/,
        'Use the form "Name <list.example.com>", in ASCII',
      )
      .nullish(),
  }),
  contactStates: z.object({
    topics: topicStates,
  }),
} as const;

/** A layout's slug (fork D34), as a topic's. */
const layoutSlug = topicSlug;

export const LayoutSchemas = {
  slug: layoutSlug,
  upsert: z.object({
    name: z.string().min(1).max(100),
    // An HTML document with exactly one `{{ content }}` slot.
    html: z
      .string()
      .min(1)
      .max(100_000)
      .refine(html => layoutSlotCount(html) === 1, 'A layout needs exactly one {{ content }} slot'),
    // Inlined into every email at send time, so its size is the cost of every send: kept small.
    css: z.string().max(50_000).nullish(),
    // New templates and campaigns start with the default layout.
    isDefault: z.boolean().optional(),
  }),
} as const;

/** A sign-in's one-time token (fork D39). */
const signInToken = z.string().min(16).max(128);

/** A WebAuthn ceremony's result as the browser hands it over (fork D39); the server verifies the rest. */
const webauthnResponse = z
  .object({
    id: z.string().min(1).max(1024),
    rawId: z.string().min(1).max(1024),
    type: z.literal('public-key'),
    response: z.record(z.string(), z.unknown()),
  })
  .passthrough();

/** Two-factor authentication (fork D39). */
export const TwoFactorSchemas = {
  // A sign-in's second step: an authenticator code (six digits) or a recovery code.
  code: z.object({challenge: signInToken, code: z.string().trim().min(6).max(32)}),
  // Passkey options: for the sign-in the token names, or without one, a passkey sign-in on its own.
  passkeyOptions: z.object({challenge: signInToken.optional()}),
  passkey: z.object({challenge: signInToken, response: webauthnResponse}),
  enableTotp: z.object({code: z.string().trim().regex(/^\d{6}$/, 'Enter the six-digit code from the app')}),
  registerPasskey: z.object({name: z.string().trim().min(1).max(100), response: webauthnResponse}),
} as const;

/** Scoped API keys (fork D37). */
export const ApiKeySchemas = {
  create: z.object({
    name: z.string().trim().min(1).max(100),
    scopes: z
      .array(z.enum(API_KEY_SCOPES))
      .min(1)
      .transform(scopes => [...new Set(scopes)]),
  }),
} as const;

export const ContactSchemas = {
  create: z.object({
    email,
    subscribed: z.boolean().default(true),
    data: jsonSchema.optional(),
  }),
  bulkAction: z.discriminatedUnion('mode', [
    z.object({
      mode: z.literal('ids'),
      contactIds: z.array(uuid).min(1).max(1000),
    }),
    z.object({
      mode: z.literal('query'),
      filter: z
        .object({
          search: z.string().max(255).optional(),
          subscribed: z.boolean().optional(),
        })
        .default({}),
      excludeIds: z.array(uuid).max(10000).optional(),
    }),
  ]),
  lookup: z.object({
    emails: z.array(z.string().email()).min(1).max(500),
  }),
  /** Body of POST /contacts/batch (fork D30): up to 100 contacts, each upserted like POST /contacts. */
  batchUpsert: z.object({
    contacts: z
      .array(
        z.object({
          email,
          subscribed: z.boolean().optional(),
          data: z.record(jsonSchema).optional(),
          // Explicit topic states by slug (fork D32).
          topics: topicStates.optional(),
        }),
      )
      .min(1)
      .max(100),
  }),
  /**
   * Body of the recipient-facing snooze endpoint. A closed enum rather than a date: the
   * endpoint is unauthenticated, so the set of states a stranger can put a contact into stays
   * small. The values double as i18n key suffixes on the snooze page.
   */
  snooze: z.object({
    duration: z.enum(SNOOZE_DURATIONS),
  }),
  /**
   * Fork (D33): body of the recipient-facing subscribe and unsubscribe endpoints. With a topic, the
   * change is to that topic only; without one, to every email, as upstream.
   */
  publicSubscription: z.object({
    topic: topicSlug.optional(),
  }),
} as const;

/** Fork (D33): body of `POST /v1/emails/:id/unsubscribed`, an unsubscribe the sender took on its own page. */
export const EmailReportSchemas = {
  unsubscribed: z.object({
    /** The topic left, by slug; `null` for every email; absent for the email's own topic. */
    topic: topicSlug.nullable().optional(),
    /** The recipient's address, checked against the email's. */
    email: z.string().email().optional(),
  }),
} as const;

const segmentFilterSchema = z.object({
  field: z.string().min(1),
  operator: z.enum([
    'equals',
    'notEquals',
    'contains',
    'notContains',
    'greaterThan',
    'lessThan',
    'greaterThanOrEqual',
    'lessThanOrEqual',
    'exists',
    'notExists',
    'within',
    'olderThan',
    'includesAny',
    'includesAll',
    'includesNone',
    'triggered',
    'triggeredWithin',
    'triggeredOlderThan',
    'notTriggered',
    'notTriggeredWithin',
    'memberOfSegment',
    'notMemberOfSegment',
  ]),
  value: z.any().optional(),
  unit: z.enum(['days', 'hours', 'minutes']).optional(),
});

const filterGroupSchema: z.ZodType<FilterGroup> = z.lazy(() =>
  z.object({
    filters: z.array(segmentFilterSchema),
    conditions: filterConditionSchema.optional(),
  }),
);

const filterConditionSchema: z.ZodType<FilterCondition> = z.lazy(() =>
  z.object({
    logic: z.enum(['AND', 'OR']),
    groups: z.array(filterGroupSchema).min(1),
  }),
);

export const SegmentSchemas = {
  filter: segmentFilterSchema,
  filterGroup: filterGroupSchema,
  filterCondition: filterConditionSchema,
  create: z.object({
    name: z.string().min(1).max(100),
    description: z.string().max(500).optional(),
    type: z.enum(['DYNAMIC', 'STATIC']).default('DYNAMIC'),
    condition: filterConditionSchema.optional(),
    trackMembership: z.boolean().default(false),
  }),
  update: z.object({
    name: z.string().min(1).max(100).optional(),
    description: z.string().max(500).optional(),
    type: z.enum(['DYNAMIC', 'STATIC']).optional(),
    condition: filterConditionSchema.optional(),
    trackMembership: z.boolean().optional(),
  }),
  members: z.object({
    emails: z.array(z.string().email()).min(1).max(500),
    createMissing: z.boolean().optional(),
    subscribed: z.boolean().optional(),
  }),
};

export const TemplateSchemas = {
  create: z.object({
    name: z.string().min(1).max(100),
    description: z.string().max(500).optional(),
    subject: z.string().min(1),
    body: z.string().min(1),
    from: email,
    fromName: z.string().max(100).nullish(),
    replyTo: email.nullish(),
    type: z.nativeEnum(TemplateType).default('MARKETING'),
    // The layout the body is sent in (fork D34): left out, the project's default layout; null, none.
    layoutId: uuid.nullish(),
  }),
  update: z.object({
    name: z.string().min(1).max(100).optional(),
    description: z.string().max(500).optional(),
    subject: z.string().min(1).optional(),
    body: z.string().min(1).optional(),
    from: email.optional(),
    fromName: z.string().max(100).nullish(),
    replyTo: email.nullish(),
    type: z.nativeEnum(TemplateType).optional(),
    // The layout the body is sent in (fork D34); null removes it.
    layoutId: uuid.nullish(),
  }),
  // Bulk operation payload for POST /templates/bulk-update.
  //
  // Currently the only supported operation is `delete: true` (bulk delete).
  // The schema is intentionally kept open-ended so future tag-related fields
  // (e.g. `addTags?: string[]`, `removeTags?: string[]`) can stack onto the
  // same endpoint once a `Template.tags` column exists — without changing the
  // request shape callers already depend on. Keep this as the single source of
  // truth for what bulk operations the endpoint accepts.
  bulkUpdate: z.object({
    ids: z.array(uuid).min(1).max(1000),
    delete: z.boolean().optional(),
  }),
};

export const WorkflowSchemas = {
  create: z.object({
    name: z.string().min(1).max(100),
    description: z.string().max(500).optional(),
    eventName: z.string().min(1),
    allowReentry: z.boolean().optional(),
    enabled: z.boolean().default(false),
  }),
  update: z.object({
    name: z.string().min(1).max(100).optional(),
    description: z.string().max(500).optional(),
    triggerType: z.nativeEnum(WorkflowTriggerType).optional(),
    triggerConfig: jsonSchema.optional(),
    enabled: z.boolean().optional(),
    allowReentry: z.boolean().optional(),
  }),
  addStep: z.object({
    type: z.nativeEnum(WorkflowStepType),
    name: z.string().min(1).max(100),
    position: jsonSchema,
    config: jsonSchema,
    templateId: uuid.optional(),
    autoConnect: z.boolean().optional(),
  }),
  updateStep: z.object({
    name: z.string().min(1).max(100).optional(),
    position: jsonSchema.optional(),
    config: jsonSchema.optional(),
    templateId: uuid.optional().nullable(),
  }),
  // Payload for POST /workflows/:id/transitions/:transitionId/insert-step.
  // Mirrors `addStep` minus `autoConnect` (the transition being split already
  // determines both sides of the wiring) and with an optional position, since
  // the builder lays the graph out with dagre anyway.
  insertStep: z.object({
    type: z.nativeEnum(WorkflowStepType),
    name: z.string().min(1).max(100),
    position: jsonSchema.optional(),
    config: jsonSchema,
    templateId: uuid.optional(),
  }),
  createTransition: z.object({
    fromStepId: uuid,
    toStepId: uuid,
    condition: jsonSchema.optional(),
    priority: z.number().int().min(0).default(0),
  }),
  startExecution: z.object({
    contactId: uuid,
    context: jsonSchema.optional(),
  }),
  // Bulk operation payload for POST /workflows/bulk-update.
  //
  // Currently the only supported operation is `delete: true` (bulk delete).
  // Mirrors `TemplateSchemas.bulkUpdate` and is intentionally kept open-ended so
  // future bulk operations (e.g. enable/disable) can stack onto the same
  // endpoint without changing the request shape callers already depend on.
  bulkUpdate: z.object({
    ids: z.array(uuid).min(1).max(1000),
    delete: z.boolean().optional(),
  }),
};

export const WorkflowStepConfigSchemas = {
  sendEmail: z.object({
    templateId: uuid,
    recipient: z
      .object({
        type: z.enum(['CONTACT', 'CUSTOM']),
        customEmail: email.optional(),
      })
      .refine(
        data => {
          // If type is CUSTOM, customEmail must be provided
          if (data.type === 'CUSTOM') {
            return !!data.customEmail;
          }
          return true;
        },
        {
          message: 'Custom email is required when recipient type is CUSTOM',
        },
      )
      .optional(),
  }),
  delay: z
    .object({
      amount: z.number().positive(),
      unit: z.enum(['minutes', 'hours', 'days']),
    })
    .refine(
      data => {
        // Max 365 days
        const maxMinutes = 365 * 24 * 60;
        const maxHours = 365 * 24;
        const maxDays = 365;

        if (data.unit === 'minutes') return data.amount <= maxMinutes;
        if (data.unit === 'hours') return data.amount <= maxHours;
        if (data.unit === 'days') return data.amount <= maxDays;
        return true;
      },
      {
        message: 'Delay cannot exceed 365 days',
      },
    ),
  waitForEvent: z.object({
    eventName: z.string().min(1),
    timeout: z.number().positive().max(31536000, 'Timeout cannot exceed 365 days (31,536,000 seconds)').optional(),
  }),
  condition: z.union([
    // Legacy binary condition (if/else)
    z.object({
      field: z.string().min(1),
      operator: z.enum([
        'equals',
        'notEquals',
        'contains',
        'notContains',
        'greaterThan',
        'lessThan',
        'greaterThanOrEqual',
        'lessThanOrEqual',
        'exists',
        'notExists',
      ]),
      value: z.any().optional(),
    }),
    // Multi-branch condition (switch/case)
    z.object({
      mode: z.literal('multi'),
      field: z.string().min(1),
      branches: z
        .array(
          z.object({
            id: z.string().min(1),
            name: z.string().min(1),
            operator: z.enum([
              'equals',
              'notEquals',
              'contains',
              'notContains',
              'greaterThan',
              'lessThan',
              'greaterThanOrEqual',
              'lessThanOrEqual',
              'exists',
              'notExists',
            ]),
            value: z.any().optional(),
          }),
        )
        .min(1)
        .max(20),
    }),
  ]),
  webhook: z.object({
    url: z.string().url(),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('POST'),
    headers: z.record(z.string()).optional(),
    body: jsonSchema.optional(),
  }),
  updateContact: z
    .object({
      updates: z.record(z.any()).optional(),
      subscriptionAction: z.enum(['none', 'subscribe', 'unsubscribe']).optional(),
    })
    .refine(
      value =>
        (value.updates && Object.keys(value.updates).length > 0) ||
        (value.subscriptionAction && value.subscriptionAction !== 'none'),
      {message: 'Provide at least one field to update or a subscription action'},
    ),
};

export const DomainSchemas = {
  create: z.object({
    projectId: uuid,
    domain: z
      .string()
      .min(3)
      .max(253)
      .refine(
        value => {
          // Basic domain validation regex
          const domainRegex = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/i;
          return domainRegex.test(value);
        },
        {
          message: 'Invalid domain format',
        },
      ),
  }),
  projectId: z.object({
    projectId: uuid,
  }),
};

export const CampaignSchemas = {
  create: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    subject: z.string().min(1),
    body: z.string().min(1),
    from: email,
    fromName: z.string().max(100).nullish(),
    replyTo: email.nullish(),
    type: z.nativeEnum(TemplateType).default(TemplateType.MARKETING),
    audienceType: z.nativeEnum(CampaignAudienceType),
    audienceCondition: filterConditionSchema.optional(),
    segmentId: uuid.optional(),
    // The topic the campaign is sent for, in a project with topics (fork D32).
    topicId: uuid.nullish(),
    // The layout the body is sent in (fork D34): left out, the project's default layout; null, none.
    layoutId: uuid.nullish(),
    // At most this many recipients per hour (fork D36); null for no cap.
    sendsPerHour: z.number().int().min(1).max(MAX_SENDS_PER_HOUR).nullish(),
  }),
  schedule: z.object({
    scheduledFor: z.string(),
  }),
  update: z.object({
    name: z.string().optional(),
    description: z.string().optional(),
    subject: z.string().optional(),
    body: z.string().optional(),
    from: z.string().optional(),
    fromName: z.string().max(100).nullish(),
    replyTo: z.string().nullish(),
    type: z.nativeEnum(TemplateType).optional(),
    audienceType: z.nativeEnum(CampaignAudienceType).optional(),
    audienceCondition: filterConditionSchema.optional(),
    segmentId: z.string().optional(),
    // The topic the campaign is sent for, in a project with topics (fork D32); null removes it.
    topicId: uuid.nullish(),
    // The layout the body is sent in (fork D34); null removes it.
    layoutId: uuid.nullish(),
    // At most this many recipients per hour (fork D36); null removes the cap. The one field a sending
    // campaign takes.
    sendsPerHour: z.number().int().min(1).max(MAX_SENDS_PER_HOUR).nullish(),
  }),
  sendTest: z.object({
    email,
    // The contact the test is rendered as (fork D35); by default the member's own contact, else sample data.
    contactId: uuid.optional(),
  }),
  // Bulk operation payload for POST /campaigns/bulk-update.
  //
  // Two modes, and exactly one of them per request:
  // - `delete: true` bulk-deletes (drafts only, enforced server-side).
  // - `archived: true | false` archives or restores the selection.
  // Mirrors `TemplateSchemas.bulkUpdate` and stays open-ended so further bulk
  // operations can stack onto the same endpoint without changing the request shape
  // callers already depend on. The mutual exclusion is enforced in
  // CampaignService.bulkUpdate rather than here, so it comes back in the same error
  // envelope as the ownership and status guards.
  bulkUpdate: z.object({
    ids: z.array(uuid).min(1).max(1000),
    delete: z.boolean().optional(),
    archived: z.boolean().optional(),
  }),
} as const;

export const ActionSchemas = {
  track: z.object({
    event: z.string().min(1),
    email,
    subscribed: z.boolean().optional(),
    data: jsonSchema.optional(),
  }),
  send: z
    .object({
      to: z.union([
        email, // Simple email string (backward compatible)
        z.object({
          // Object with name and email
          name: z.string().regex(/^[^\r\n]*$/, 'Name contains invalid characters').optional(),
          email: email,
        }),
        z.array(
          z.union([
            email, // Array of email strings
            z.object({
              // Array of objects with name and email
              name: z.string().regex(/^[^\r\n]*$/, 'Name contains invalid characters').optional(),
              email: email,
            }),
          ]),
        ),
      ]),
      subject: z.string().min(1).max(998).regex(/^[^\r\n]*$/, 'Subject contains invalid characters').optional(),
      body: z.string().min(1).optional(),
      template: uuid.optional(),
      // false sends the subject and body as they are, without filling in placeholders
      templating: z.boolean().optional(),
      // Place in the sending queue: high (the default for these emails), normal or low
      priority: z.enum(['high', 'normal', 'low']).optional(),
      subscribed: z.boolean().optional(),
      name: z.string().regex(/^[^\r\n]*$/, 'Name contains invalid characters').optional(),
      from: z
        .union(
          [
            email, // Simple email string (backward compatible)
            z.object({
              // Object with name and email
              name: z.string().regex(/^[^\r\n]*$/, 'Name contains invalid characters').optional(),
              email: email,
            }),
          ],
          {
            errorMap: (issue, ctx) => {
              if (issue.code === z.ZodIssueCode.invalid_union) {
                return {
                  message:
                    'Invalid "from" field. Expected a valid email string (e.g., "hello@example.com") or an object with an email field and optional name (e.g., {email: "hello@example.com", name: "My App"})',
                };
              }
              return {message: ctx.defaultError};
            },
          },
        )
        .optional(),
      reply: email.optional(),
      headers: z
        .record(
          z
            .string()
            // RFC 5322 field name: printable ASCII except the colon
            .regex(/^[!-9;-~]+$/, 'Header key contains invalid characters')
            .refine(key => !/^x-plunk-/i.test(key), 'X-Plunk-* headers are reserved for Plunk'),
          z.string().max(998).regex(/^[^\r\n]*$/, 'Header value contains invalid characters'),
        )
        .optional(),
      data: jsonSchema.optional(),
      attachments: z
        .array(
          z.object({
            filename: z.string().min(1).max(255).regex(/^[^\r\n"]+$/, 'Filename contains invalid characters'),
            content: z.string().min(1), // Base64 encoded file content
            contentType: z.string().min(1).max(255).regex(/^[^\r\n]+$/, 'Content type contains invalid characters'),
            contentId: z
              .string()
              .min(1)
              .max(255)
              .regex(/^[^<>\r\n]+$/, 'Content ID cannot contain <, >, \\r, or \\n')
              .optional(),
            disposition: z.enum(['attachment', 'inline']).default('attachment'),
          })
            .refine(data => data.disposition !== 'inline' || !!data.contentId, {
              message: 'Content ID is required when disposition is inline',
              path: ['contentId'],
            }),
        )
        .max(Number(process.env['MAX_ATTACHMENTS_COUNT'] ?? 10))
        .optional(),
    })
    .superRefine((data, ctx) => {
      // Validate that either template or subject+body are provided
      if (!data.template && !(data.subject && data.body)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Either template ID or both subject and body are required',
          path: ['template'],
        });
      }

      // A template's content is written with placeholders for Plunk to fill in
      if (data.templating === false && data.template) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'templating: false cannot be combined with a template',
          path: ['templating'],
        });
      }

      // Validate total attachment size
      if (data.attachments && data.attachments.length > 0) {
        const maxSizeMb = Number(process.env['MAX_ATTACHMENT_SIZE_MB'] ?? 10);
        const maxBase64Length = Math.floor((maxSizeMb * 1024 * 1024 * 4) / 3);
        const totalBase64Length = data.attachments.reduce((sum, att) => sum + att.content.length, 0);
        if (totalBase64Length > maxBase64Length) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Total attachment size must not exceed ${maxSizeMb}MB`,
            path: ['attachments'],
          });
        }
      }
    }),
  verify: z.object({
    email,
  }),
} as const;

/** The most emails one `POST /v1/send/batch` request takes. */
export const SEND_BATCH_MAX_EMAILS = 100;

/**
 * One email of a `POST /v1/send/batch` request: a `POST /v1/send` body for a single recipient,
 * with an optional key that makes retrying it safe.
 */
const sendBatchItem = z
  .object({
    idempotencyKey: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[\x20-\x7e]+$/, 'Idempotency key must be printable ASCII')
      .optional(),
  })
  .passthrough()
  .transform((item, ctx) => {
    const {idempotencyKey, ...fields} = item;
    if (Array.isArray(fields.to)) {
      ctx.addIssue({code: z.ZodIssueCode.custom, message: 'Each email of a batch has one recipient', path: ['to']});
      return z.NEVER;
    }
    const result = ActionSchemas.send.safeParse(fields);
    if (!result.success) {
      for (const issue of result.error.issues) {
        ctx.addIssue(issue);
      }
      return z.NEVER;
    }
    return {idempotencyKey, request: result.data};
  });

export const SendBatchSchema = z
  .object({
    emails: z.array(sendBatchItem).min(1).max(SEND_BATCH_MAX_EMAILS),
  })
  .superRefine(({emails}, ctx) => {
    // A key names one email: two emails with the same key would be the same email.
    const firstWithKey = new Map<string, number>();
    emails.forEach(({idempotencyKey}, index) => {
      if (idempotencyKey === undefined) {
        return;
      }
      const first = firstWithKey.get(idempotencyKey);
      if (first === undefined) {
        firstWithKey.set(idempotencyKey, index);
      } else {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Email ${first} of the batch has the same idempotency key`,
          path: ['emails', index, 'idempotencyKey'],
        });
      }
    });
  });

export const BillingLimitSchemas = {
  update: z.object({
    workflows: z.coerce.number().int().positive().nullable(),
    campaigns: z.coerce.number().int().positive().nullable(),
    transactional: z.coerce.number().int().positive().nullable(),
    inbound: z.coerce.number().int().positive().nullable(),
  }),
} as const;

export const MembershipSchemas = {
  addMember: z.object({
    email,
    role: z.enum(['ADMIN', 'MEMBER']).default('MEMBER'),
  }),
  updateRole: z.object({
    role: z.enum(['ADMIN', 'MEMBER']),
  }),
} as const;
