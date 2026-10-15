import {Controller, Delete, Get, Middleware, Patch, Post} from '@overnightjs/core';
import type {NextFunction, Request, Response} from 'express';
import {requireAuth, requireEmailVerified} from '../middleware/auth.js';
import {SegmentService} from '../services/SegmentService.js';
import {CatchAsync} from '../utils/asyncHandler.js';

@Controller('segments')
export class Segments {
  /**
   * GET /segments
   * List all segments for the authenticated project
   */
  @Get('')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async list(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;

    const segments = await SegmentService.list(auth.projectId!);

    return res.status(200).json(segments);
  }

  /**
   * GET /segments/:id
   * Get a specific segment by ID with member count
   */
  @Get(':id')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async get(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const segmentId = req.params.id;

    if (!segmentId) {
      return res.status(400).json({error: 'Segment ID is required'});
    }

    const segment = await SegmentService.get(auth.projectId!, segmentId);

    return res.status(200).json(segment);
  }

  /**
   * GET /segments/:id/contacts
   * Get contacts that match a segment's filters
   */
  @Get(':id/contacts')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async getContacts(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const segmentId = req.params.id;
    const page = parseInt(req.query.page as string) || 1;
    const pageSize = Math.min(parseInt(req.query.pageSize as string) || 20, 100);

    if (!segmentId) {
      return res.status(400).json({error: 'Segment ID is required'});
    }

    const result = await SegmentService.getContacts(auth.projectId!, segmentId, page, pageSize);

    return res.status(200).json(result);
  }

  /**
   * POST /segments
   * Create a new segment
   */
  @Post('')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async create(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const {name, description, type, condition, trackMembership} = req.body;

    if (!name) {
      return res.status(400).json({error: 'Name is required'});
    }

    const segmentType = type ?? 'DYNAMIC';

    if (segmentType === 'DYNAMIC' && (!condition || typeof condition !== 'object')) {
      return res.status(400).json({error: 'Condition is required and must be an object for DYNAMIC segments'});
    }

    const segment = await SegmentService.create(
      auth.projectId!,
      {
        name,
        description,
        type: segmentType,
        condition: segmentType === 'DYNAMIC' ? condition : undefined,
        trackMembership,
      },
      auth.apiKeyId ?? null,
    );

    return res.status(201).json(segment);
  }

  /**
   * PATCH /segments/:id
   * Update a segment
   */
  @Patch(':id')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async update(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const segmentId = req.params.id;
    const {name, description, condition, trackMembership} = req.body;

    if (!segmentId) {
      return res.status(400).json({error: 'Segment ID is required'});
    }

    if (condition !== undefined && typeof condition !== 'object') {
      return res.status(400).json({error: 'Condition must be an object'});
    }

    const segment = await SegmentService.update(
      auth.projectId!,
      segmentId,
      {
        name,
        description,
        condition,
        trackMembership,
      },
      auth.apiKeyId ?? null,
    );

    return res.status(200).json(segment);
  }

  /**
   * DELETE /segments/:id
   * Delete a segment
   */
  @Delete(':id')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async delete(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const segmentId = req.params.id;

    if (!segmentId) {
      return res.status(400).json({error: 'Segment ID is required'});
    }

    await SegmentService.delete(auth.projectId!, segmentId);

    return res.status(204).send();
  }

  /**
   * POST /segments/:id/members
   * Add contacts to a static segment by email
   */
  @Post(':id/members')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async addMembers(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const segmentId = req.params.id;
    const {emails, createMissing, subscribed} = req.body as {emails: string[]; createMissing?: boolean; subscribed?: boolean};

    if (!segmentId) {
      return res.status(400).json({error: 'Segment ID is required'});
    }

    if (!Array.isArray(emails) || emails.length === 0) {
      return res.status(400).json({error: 'emails must be a non-empty array'});
    }

    const result = await SegmentService.addContacts(auth.projectId!, segmentId, emails, createMissing ?? false, subscribed ?? true);

    return res.status(200).json(result);
  }

  /**
   * DELETE /segments/:id/members
   * Remove contacts from a static segment by email
   */
  @Delete(':id/members')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async removeMembers(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const segmentId = req.params.id;
    const {emails} = req.body;

    if (!segmentId) {
      return res.status(400).json({error: 'Segment ID is required'});
    }

    if (!Array.isArray(emails) || emails.length === 0) {
      return res.status(400).json({error: 'emails must be a non-empty array'});
    }

    const result = await SegmentService.removeContacts(auth.projectId!, segmentId, emails);

    return res.status(200).json(result);
  }

  /**
   * POST /segments/:id/compute
   * Recompute segment membership for all contacts
   */
  @Post(':id/compute')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async compute(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const segmentId = req.params.id;

    if (!segmentId) {
      return res.status(400).json({error: 'Segment ID is required'});
    }

    const result = await SegmentService.computeMembership(auth.projectId!, segmentId);

    return res.status(200).json(result);
  }

  /**
   * POST /segments/:id/refresh
   * Refresh segment member count
   */
  @Post(':id/refresh')
  @Middleware([requireAuth, requireEmailVerified])
  @CatchAsync
  public async refresh(req: Request, res: Response, _next: NextFunction) {
    const auth = res.locals.auth;
    const segmentId = req.params.id;

    if (!segmentId) {
      return res.status(400).json({error: 'Segment ID is required'});
    }

    const memberCount = await SegmentService.refreshMemberCount(auth.projectId!, segmentId);

    return res.status(200).json({memberCount});
  }
}
