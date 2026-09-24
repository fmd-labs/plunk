import {Controller, Middleware, Post} from '@overnightjs/core';
import {ActionSchemas, SendBatchSchema} from '@plunk/shared';
import type {NextFunction, Request, Response} from 'express';
import {requirePublicKey, requireSecretKey} from '../middleware/auth.js';
import {
  claimUnfinished,
  type IdempotencyContext,
  idempotency,
  keyReused,
  resumableIdempotency,
} from '../middleware/idempotency.js';
import {sendBatchRateLimit, sendRateLimit, trackRateLimit} from '../middleware/rateLimit.js';
import {ContactService} from '../services/ContactService.js';
import {EmailVerificationService} from '../services/EmailVerificationService.js';
import {EventService} from '../services/EventService.js';
import {TransactionalSendService} from '../services/TransactionalSendService.js';
import {BadRequest, ValidationError} from '../exceptions/index.js';
import {CatchAsync} from '../utils/asyncHandler.js';

/**
 * Public API Actions Controller
 * Handles track event, transactional email, and email verification endpoints
 */
@Controller('v1')
export class Actions {
  /**
   * POST /v1/track
   * Track an event for a contact (creates/updates contact and tracks event)
   *
   * Headers:
   * - Idempotency-Key: string (optional) - Refuses the request with 409 if this key
   *   was already used by this project. See middleware/idempotency.ts.
   *
   * Request body:
   * - event: string (required) - Event name
   * - email: string (required) - Contact email
   * - subscribed: boolean (optional) - Contact subscription status (only updates if explicitly specified)
   * - data: object (optional) - Event and contact data
   *   - Simple values are saved to contact (persistent)
   *   - {value: any, persistent: false} are only available to workflows (non-persistent)
   *
   * Response:
   * - success: boolean
   * - data: object with contact ID, event ID, and timestamp
   *
   * Example:
   * {
   *   event: "purchase",
   *   email: "user@example.com",
   *   data: {
   *     totalSpent: 1500,                          // Persistent - saved to contact
   *     plan: "pro",                                // Persistent - saved to contact
   *     orderId: {value: "12345", persistent: false},  // Non-persistent - workflows only
   *     receiptUrl: {value: "https://...", persistent: false}  // Non-persistent - workflows only
   *   }
   * }
   */
  @Post('track')
  @Middleware([requirePublicKey, trackRateLimit, idempotency])
  @CatchAsync
  public async track(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;

    // Zod validation - errors automatically handled by global error handler
    const {event, email, subscribed, data} = ActionSchemas.track.parse(req.body);

    // Prevent manual tracking of reserved system events
    if (EventService.isReservedEvent(event)) {
      throw new ValidationError(
        [
          {
            field: 'event',
            message: `Event name "${event}" is reserved for system use and cannot be manually tracked`,
            code: 'reserved_event',
            received: event,
          },
        ],
        'Cannot track reserved system event',
      );
    }

    // Create or update contact with persistent data only
    // ContactService.upsert will filter out non-persistent fields
    // Event tracking should subscribe new contacts by default (subscribed=true in ContactService)
    // but preserve existing subscription state for existing contacts
    const contact = await ContactService.upsert(
      auth.projectId,
      email,
      data as Record<string, unknown> | undefined,
      subscribed,
    );

    // Track the event with ALL data (persistent + non-persistent)
    // Non-persistent data flows to workflows via execution context
    const eventRecord = await EventService.trackEvent(
      auth.projectId,
      event,
      contact.id,
      undefined,
      data as Record<string, unknown> | undefined,
    );

    return res.status(200).json({
      success: true,
      data: {
        contact: contact.id,
        event: eventRecord.id,
        timestamp: eventRecord.createdAt.toISOString(),
      },
    });
  }

  /**
   * POST /v1/send
   * Send transactional email(s)
   *
   * Headers:
   * - Idempotency-Key: string (optional) - Sends each recipient's email at most once per key. A
   *   retry of a request that succeeded, or is still in flight, is refused with 409 and the emails
   *   it created (`details.emails`); a retry of one that failed or died finishes it without
   *   repeating the emails it already queued. See middleware/idempotency.ts.
   *
   * Request body:
   * - to: string | object | array (required) - Recipient email(s)
   *   - String: "user@example.com"
   *   - Object: {name: "Jane Doe", email: "user@example.com"}
   *   - Array: ["user1@example.com", {name: "Jane", email: "user2@example.com"}]
   * - subject: string (required) - Email subject
   * - body: string (required) - Email HTML body
   * - subscribed: boolean (optional) - Contact subscription status (only updates if explicitly specified)
   * - name: string (optional) - Sender name (alternative to from.name)
   * - from: string | object (optional) - Sender email or {name, email} object (must be from verified domain)
   * - reply: string (optional) - Reply-to email
   * - headers: object (optional) - Additional email headers
   * - data: object (optional) - Contact data and template variables
   *   - Simple values are saved to contact (persistent)
   *   - {value: any, persistent: false} are only used for this email (non-persistent)
   * - attachments: array (optional) - Email attachments (configurable via MAX_ATTACHMENTS_COUNT / MAX_ATTACHMENT_SIZE_MB, defaults: 10 / 10MB)
   *   - filename: string (required) - Attachment filename
   *   - content: string (required) - Base64 encoded file content
   *   - contentType: string (required) - MIME type (e.g., "application/pdf")
   *
   * Response:
   * - success: boolean
   * - data: object with emails array and timestamp
   *
   * Examples:
   *
   * Simple format (backward compatible):
   * {
   *   to: "user@example.com",
   *   subject: "Password Reset",
   *   body: "<p>Reset code: {{resetCode}}</p><p>Hello {{firstName}}!</p>",
   *   from: "noreply@example.com",
   *   name: "My App",
   *   data: {
   *     firstName: "John",                              // Persistent - saved to contact
   *     resetCode: {value: "ABC123", persistent: false} // Non-persistent - this email only
   *   }
   * }
   *
   * Object format (recommended):
   * {
   *   to: {
   *     name: "Jane Doe",
   *     email: "user@example.com"
   *   },
   *   subject: "Password Reset",
   *   body: "<p>Reset code: {{resetCode}}</p>",
   *   from: {
   *     name: "My App",
   *     email: "noreply@example.com"
   *   }
   * }
   *
   * Multiple recipients with names:
   * {
   *   to: [
   *     {name: "Jane Doe", email: "jane@example.com"},
   *     {name: "John Smith", email: "john@example.com"}
   *   ],
   *   subject: "Newsletter",
   *   body: "<p>Hello {{name}}!</p>",
   *   from: {name: "Newsletter", email: "news@example.com"}
   * }
   */
  @Post('send')
  @Middleware([requireSecretKey, sendRateLimit, resumableIdempotency])
  @CatchAsync
  public async send(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const claim = res.locals.idempotency as IdempotencyContext | undefined;

    // Zod validation - errors automatically handled by global error handler
    const request = ActionSchemas.send.parse(req.body);

    // A key an earlier request used: refused with the emails that request created while it is in
    // flight or once it succeeded. Otherwise it failed or died, and this request finishes its work.
    if (claim?.reused && !claimUnfinished(claim.reused)) {
      const emails = await TransactionalSendService.findQueued(auth.projectId, request, claim.claimId);
      throw keyReused(claim.key, claim.reused, {emails});
    }

    const send = await TransactionalSendService.prepare(auth.projectId, request);

    // Emails are written from here on, so a refusal of a later recipient must keep the key: a retry
    // has to find the emails already queued rather than send them again.
    if (claim) {
      claim.keepOnClientError = true;
    }

    const timestamp = new Date();
    const emails = await TransactionalSendService.sendToAll(send, claim?.claimId);

    return res.status(200).json({
      success: true,
      data: {
        emails,
        timestamp: timestamp.toISOString(),
      },
    });
  }

  /**
   * POST /v1/send/batch
   * Send up to 100 transactional emails in one request, each to one recipient.
   *
   * Request body:
   * - emails: array (1-100) of POST /v1/send bodies, each with a single recipient in `to`, and an
   *   optional `idempotencyKey`. An email whose key an earlier batch of the project used is not
   *   sent again, whoever it is to: it is reported as a duplicate with the id of the email that
   *   was. Keys expire like Idempotency-Key headers. The Idempotency-Key header itself is refused,
   *   as it would read as covering the batch.
   *
   * Every email is checked before any is sent: an invalid one, or one that cannot be sent (an
   * unknown template, a sender domain that is not verified), fails the whole request with 422, and
   * nothing is sent. The error names each such email as `emails.<index>`.
   *
   * Response:
   * - data.emails: a result per email, in order: `queued` or `duplicate`, with the email's `email`
   *   id and `contact`, or `failed`, with an `error` (`code`, `message`, `retryable`).
   */
  @Post('send/batch')
  @Middleware([requireSecretKey, sendBatchRateLimit])
  @CatchAsync
  public async sendBatch(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;

    if (req.headers['idempotency-key'] !== undefined) {
      throw new BadRequest('Idempotency-Key does not apply to a batch: give each email an idempotencyKey instead');
    }

    // Zod validation - errors automatically handled by global error handler
    const {emails} = SendBatchSchema.parse(req.body);

    const sends = await TransactionalSendService.prepareBatch(
      auth.projectId,
      emails.map(({request}) => request),
    );

    const timestamp = new Date();
    const results = [];
    for (const [index, send] of sends.entries()) {
      results.push(await TransactionalSendService.sendBatchItem(send, emails[index]!.idempotencyKey));
    }

    return res.status(200).json({
      success: true,
      data: {
        emails: results,
        timestamp: timestamp.toISOString(),
      },
    });
  }

  /**
   * POST /v1/verify
   * Verify an email address
   *
   * Request body:
   * - email: string (required) - Email address to verify
   *
   * Response:
   * - success: boolean
   * - data: object with verification results
   *   - email: string - Email address that was verified
   *   - valid: boolean - Whether the email appears to be valid
   *   - isDisposable: boolean - Whether the email is from a disposable domain
   *   - hasMxRecords: boolean - Whether the domain has MX records configured
   *   - suggestedEmail?: string - Suggested correction if typo detected
   *   - reasons: string[] - Array of reasons describing the verification results
   *
   * Example:
   * {
   *   email: "user@gmial.com"
   * }
   *
   * Response:
   * {
   *   success: true,
   *   data: {
   *     email: "user@gmial.com",
   *     valid: false,
   *     isDisposable: false,
   *     hasMxRecords: false,
   *     suggestedEmail: "user@gmail.com",
   *     reasons: [
   *       "Possible typo detected, did you mean user@gmail.com?",
   *       "Domain does not exist or has no MX records"
   *     ]
   *   }
   * }
   */
  @Post('verify')
  @Middleware([requireSecretKey])
  @CatchAsync
  public async verify(req: Request, res: Response, _next: NextFunction) {
    // Zod validation - errors automatically handled by global error handler
    const {email} = ActionSchemas.verify.parse(req.body);

    // Verify the email address
    const verificationResult = await EmailVerificationService.verifyEmail(email);

    return res.status(200).json({
      success: true,
      data: verificationResult,
    });
  }
}
