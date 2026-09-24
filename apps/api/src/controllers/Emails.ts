import {Controller, Get, Middleware} from '@overnightjs/core';
import {UtilitySchemas} from '@plunk/shared';
import type {NextFunction, Request, Response} from 'express';

import {prisma} from '../database/prisma.js';
import {NotFound} from '../exceptions/index.js';
import {requireSecretKey} from '../middleware/auth.js';
import {CatchAsync} from '../utils/asyncHandler.js';

@Controller('v1/emails')
export class Emails {
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
}
