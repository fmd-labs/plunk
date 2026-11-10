import {Controller, Get, Middleware, Patch, Post} from '@overnightjs/core';
import {EmailReportSchemas, EmailSchemas, UtilitySchemas} from '@plunk/shared';
import type {NextFunction, Request, Response} from 'express';

import {prisma} from '../database/prisma.js';
import {NotFound} from '../exceptions/index.js';
import {requireAuth, requireEmailVerified, requireSecretKey} from '../middleware/auth.js';
import {EmailService} from '../services/EmailService.js';
import {ListManagementService} from '../services/ListManagementService.js';
import {CatchAsync} from '../utils/asyncHandler.js';

/**
 * The email resource: looking up one email, and changing a scheduled transactional email
 * (`delivery.at` on POST /v1/send) before it goes out.
 */
@Controller('emails')
export class Emails {
  /**
   * GET /emails/:id
   * One email of the project: its status, and when it is scheduled for or was sent
   */
  @Get(':id')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async get(req: Request, res: Response, _next: NextFunction) {
    const {id} = UtilitySchemas.id.parse(req.params);

    const email = await EmailService.getEmail(res.locals.auth.projectId, id);

    return res.status(200).json(email);
  }

  /**
   * PATCH /emails/:id
   * Move a scheduled transactional email to another time. A time that is not in the future
   * sends it now. 409 EMAIL_NOT_SCHEDULED once it is sending, sent or cancelled.
   *
   * Body: { delivery: { at: ISO 8601 date with timezone } }
   */
  @Patch(':id')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async reschedule(req: Request, res: Response, _next: NextFunction) {
    const {id} = UtilitySchemas.id.parse(req.params);
    const {delivery} = EmailSchemas.reschedule.parse(req.body);

    const email = await EmailService.reschedule(res.locals.auth.projectId, id, delivery.at ?? new Date());

    return res.status(200).json(email);
  }

  /**
   * POST /emails/:id/cancel
   * Cancel a scheduled transactional email. It is not sent or billed, and a notification it
   * held under `delivery.throttle` may be sent again straight away. 409 EMAIL_NOT_SCHEDULED
   * once it is sending, sent or cancelled.
   */
  @Post(':id/cancel')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async cancel(req: Request, res: Response, _next: NextFunction) {
    const {id} = UtilitySchemas.id.parse(req.params);

    const email = await EmailService.cancelScheduled(res.locals.auth.projectId, id);

    return res.status(200).json(email);
  }
}

/**
 * Fork (D14, D33): the status of one email for API callers, and the unsubscribe report-back.
 */
@Controller('v1/emails')
export class V1Emails {
  /**
   * GET /v1/emails/:id
   * Where one email of the project stands: its status, the time of each delivery event, and its
   * open and click counts. Deliberately nothing of its content (subject, body, headers,
   * attachments), which a status check has no use for.
   */
  @Get(':id')
  @Middleware([requireSecretKey])
  @CatchAsync
  public async get(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const {id} = UtilitySchemas.id.parse(req.params);

    const email = await prisma.email.findFirst({
      where: {id, projectId: auth.projectId},
      select: {
        id: true,
        status: true,
        error: true,
        messageId: true,
        sourceType: true,
        contactId: true,
        templateId: true,
        campaignId: true,
        createdAt: true,
        scheduledFor: true,
        sentAt: true,
        deliveredAt: true,
        openedAt: true,
        clickedAt: true,
        bouncedAt: true,
        complainedAt: true,
        opens: true,
        clicks: true,
      },
    });

    // Another project's email reads as missing too: the answer must not reveal that it exists.
    if (!email) {
      throw new NotFound('email', id);
    }

    return res.status(200).json({success: true, data: email});
  }

  /**
   * POST /v1/emails/:id/unsubscribed
   * Fork (D33): report an unsubscribe the recipient of this email took on the sender's own page
   * (the project's unsubscribe URL template). Unsubscribes the contact from `topic` (by default the
   * topic of the email's campaign; `null` for every email), and the first report of the email tracks
   * `contact.unsubscribed` against it and counts it against its campaign. Safe to retry.
   */
  @Post(':id/unsubscribed')
  @Middleware([requireSecretKey])
  @CatchAsync
  public async unsubscribed(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const {id} = UtilitySchemas.id.parse(req.params);
    const report = EmailReportSchemas.unsubscribed.parse(req.body ?? {});

    const result = await ListManagementService.reportUnsubscribe(auth.projectId!, id, report);

    return res.status(200).json({success: true, data: result});
  }
}
