import {Controller, Delete, Get, Middleware, Post} from '@overnightjs/core';
import type {NextFunction, Request, Response} from 'express';
import {ApiKeySchemas, UtilitySchemas} from '@plunk/shared';
import type {AuthResponse} from '@plunk/types';

import {NotAllowed} from '../exceptions/index.js';
import {requireAuth, requireEmailVerified} from '../middleware/auth.js';
import {ApiKeyService} from '../services/ApiKeyService.js';
import {MembershipService} from '../services/MembershipService.js';
import {CatchAsync} from '../utils/asyncHandler.js';

/** Keys are managed by people in the dashboard, never with an API key. */
function personOf(auth: AuthResponse): string {
  if (auth.type !== 'jwt' || !auth.userId) {
    throw new NotAllowed('API keys are managed in the dashboard');
  }
  return auth.userId;
}

/** Scoped API keys of the authenticated project (fork D37): every member sees them, admins create and revoke. */
@Controller('api-keys')
export class ApiKeys {
  /**
   * GET /api-keys
   * The project's keys, revoked ones included, without secrets
   */
  @Get('')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async list(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    personOf(auth);

    return res.status(200).json(await ApiKeyService.list(auth.projectId));
  }

  /**
   * POST /api-keys
   * Create a key: `{ name, scopes }`. The response holds its secret, shown this once.
   */
  @Post('')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async create(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    await MembershipService.requireAdminAccess(personOf(auth), auth.projectId);
    const input = ApiKeySchemas.create.parse(req.body);

    return res.status(201).json(await ApiKeyService.create(auth.projectId, input));
  }

  /**
   * DELETE /api-keys/:id
   * Revoke a key: its next request is refused. It stays listed, for the campaigns and templates it names.
   */
  @Delete(':id')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async revoke(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    await MembershipService.requireAdminAccess(personOf(auth), auth.projectId);
    const {id} = UtilitySchemas.id.parse(req.params);

    return res.status(200).json(await ApiKeyService.revoke(auth.projectId, id));
  }
}
