import {Controller, Delete, Get, Middleware, Put} from '@overnightjs/core';
import type {NextFunction, Request, Response} from 'express';
import {TopicSchemas} from '@plunk/shared';

import {requireAuth, requireEmailVerified} from '../middleware/auth.js';
import {TopicService} from '../services/TopicService.js';
import {CatchAsync} from '../utils/asyncHandler.js';

/** Topics of the authenticated project (fork D32). */
@Controller('topics')
export class Topics {
  /**
   * GET /topics
   * List the project's topics
   */
  @Get('')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async list(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;

    return res.status(200).json(await TopicService.list(auth.projectId!));
  }

  /**
   * PUT /topics/:slug
   * Create the topic with this slug, or update it
   */
  @Put(':slug')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async upsert(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const slug = TopicSchemas.slug.parse(req.params.slug);
    const input = TopicSchemas.upsert.parse(req.body);

    const {topic, created} = await TopicService.upsert(auth.projectId!, slug, input);

    return res.status(created ? 201 : 200).json(topic);
  }

  /**
   * DELETE /topics/:slug
   * Delete a topic and every contact's state for it
   */
  @Delete(':slug')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async delete(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const slug = TopicSchemas.slug.parse(req.params.slug);

    await TopicService.delete(auth.projectId!, slug);

    return res.status(204).send();
  }
}
