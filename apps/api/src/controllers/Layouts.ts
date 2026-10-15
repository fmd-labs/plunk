import {Controller, Delete, Get, Middleware, Put} from '@overnightjs/core';
import type {NextFunction, Request, Response} from 'express';
import {LayoutSchemas, validateTemplate} from '@plunk/shared';

import {ErrorCode, HttpException} from '../exceptions/index.js';
import {requireAuth, requireEmailVerified} from '../middleware/auth.js';
import {LayoutService} from '../services/LayoutService.js';
import {CatchAsync} from '../utils/asyncHandler.js';

/** Layouts of the authenticated project (fork D34). */
@Controller('layouts')
export class Layouts {
  /**
   * GET /layouts
   * List the project's layouts
   */
  @Get('')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async list(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;

    return res.status(200).json(await LayoutService.list(auth.projectId!));
  }

  /**
   * GET /layouts/:slug
   * Get one layout
   */
  @Get(':slug')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async get(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const slug = LayoutSchemas.slug.parse(req.params.slug);

    return res.status(200).json(await LayoutService.get(auth.projectId!, slug));
  }

  /**
   * PUT /layouts/:slug
   * Create the layout with this slug, or update it
   */
  @Put(':slug')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async upsert(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const slug = LayoutSchemas.slug.parse(req.params.slug);
    const input = LayoutSchemas.upsert.parse(req.body);

    // A layout renders together with the bodies it wraps, so a syntax error would break every one of them.
    const validation = validateTemplate(input.html);
    if (!validation.valid) {
      throw new HttpException(
        400,
        `The layout is not valid Liquid: ${validation.error}${validation.line ? ` (line ${validation.line})` : ''}`,
        ErrorCode.VALIDATION_ERROR,
      );
    }

    const {layout, created} = await LayoutService.upsert(auth.projectId!, slug, input);

    return res.status(created ? 201 : 200).json(layout);
  }

  /**
   * DELETE /layouts/:slug
   * Delete a layout; templates and draft campaigns in it go without one
   */
  @Delete(':slug')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async delete(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const slug = LayoutSchemas.slug.parse(req.params.slug);

    await LayoutService.delete(auth.projectId!, slug);

    return res.status(204).send();
  }
}
