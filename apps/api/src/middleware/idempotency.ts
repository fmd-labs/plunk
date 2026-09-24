import type {NextFunction, Request, Response} from 'express';
import signale from 'signale';

import {IDEMPOTENCY_KEY_TTL_HOURS} from '../app/constants.js';
import {prisma} from '../database/prisma.js';
import {BadRequest, ConflictError, ErrorCode} from '../exceptions/index.js';

const HEADER = 'idempotency-key';
const MAX_KEY_LENGTH = 255;
const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;

/**
 * How long a claim whose request has not answered yet counts as in flight. Past it, the request is
 * taken to have died, and a retry on a resumable route finishes its work.
 */
export const IN_FLIGHT_MS = 30_000;

/** A key claim, as a later request with the same key sees it. */
export interface KeyClaim {
  id: string;
  method: string;
  path: string;
  createdAt: Date;
  /** Null while the claiming request is in flight. */
  statusCode: number | null;
}

/** What a handler learns about the request's Idempotency-Key, as `res.locals.idempotency`. */
export interface IdempotencyContext {
  key: string;
  /** The claim this request works under: its own, or, when `reused` is set, an earlier request's. */
  claimId: string;
  /** On a resumable route, the earlier request of the same endpoint that claimed the key. */
  reused?: KeyClaim;
  /**
   * Set by a handler once it has started writing. A 4xx after that point keeps the claim, as a 5xx
   * does: part of the work may be done, and a retry has to finish it rather than start over.
   */
  keepOnClientError?: boolean;
}

/** The 409 for a key an earlier request claimed, with whatever the handler adds to its details. */
export function keyReused(key: string, claim: KeyClaim | null, details: Record<string, unknown> = {}) {
  return new ConflictError(
    `Idempotency-Key "${key}" has already been used`,
    claim
      ? {
          key,
          originalRequest: `${claim.method} ${claim.path}`,
          originalRequestAt: claim.createdAt.toISOString(),
          // Null while the original request is still in flight
          originalStatusCode: claim.statusCode,
          ...details,
        }
      : {key, ...details},
    ErrorCode.IDEMPOTENCY_KEY_REUSED,
  );
}

/**
 * Whether the request that made a claim is over without having succeeded, so that a retry should
 * finish its work: it failed, or it never answered and started too long ago to still be running.
 */
export function claimUnfinished(claim: KeyClaim, now = Date.now()): boolean {
  if (claim.statusCode === null) {
    return now - claim.createdAt.getTime() >= IN_FLIGHT_MS;
  }
  return claim.statusCode < 200 || claim.statusCode >= 300;
}

function settle(claimId: string, update: Promise<unknown>) {
  update.catch((error: unknown) => {
    signale.error(`[IDEMPOTENCY] Failed to settle key claim ${claimId}:`, error);
  });
}

function createIdempotency({resumable}: {resumable: boolean}) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers[HEADER];

    if (header === undefined) {
      return next();
    }

    try {
      const key = Array.isArray(header) ? header[0] : header;

      if (!key || key.length > MAX_KEY_LENGTH || !PRINTABLE_ASCII.test(key)) {
        throw new BadRequest(
          `Idempotency-Key must be 1-${MAX_KEY_LENGTH} printable ASCII characters`,
          ErrorCode.BAD_REQUEST,
        );
      }

      const projectId = res.locals.auth.projectId as string;

      const expiresAt = new Date(Date.now() + IDEMPOTENCY_KEY_TTL_HOURS * 60 * 60 * 1000);

      let claimId: string;

      try {
        const claim = await prisma.idempotencyKey.create({
          data: {projectId, key, method: req.method, path: req.path, expiresAt},
          select: {id: true},
        });
        claimId = claim.id;
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'P2002')) {
          throw error;
        }

        const existing = await prisma.idempotencyKey.findUnique({
          where: {projectId_key: {projectId, key}},
          select: {id: true, method: true, path: true, createdAt: true, statusCode: true},
        });

        // A resumable route takes the claim over from an earlier request to the same endpoint, and
        // decides itself between refusing and finishing that request's work.
        if (!resumable || !existing || existing.method !== req.method || existing.path !== req.path) {
          throw keyReused(key, existing);
        }

        const context: IdempotencyContext = {key, claimId: existing.id, reused: existing};
        res.locals.idempotency = context;

        // A retry that finished the work records the success. Any other answer leaves the claim as the
        // earlier request left it: releasing it would let a new request repeat what that one did.
        res.on('finish', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            settle(
              existing.id,
              prisma.idempotencyKey.update({where: {id: existing.id}, data: {statusCode: res.statusCode}}),
            );
          }
        });

        return next();
      }

      const context: IdempotencyContext = {key, claimId};
      res.locals.idempotency = context;

      res.on('finish', () => {
        const release = res.statusCode >= 400 && res.statusCode < 500 && !context.keepOnClientError;

        settle(
          claimId,
          release
            ? prisma.idempotencyKey.delete({where: {id: claimId}})
            : prisma.idempotencyKey.update({where: {id: claimId}, data: {statusCode: res.statusCode}}),
        );
      });

      return next();
    } catch (error) {
      return next(error);
    }
  };
}

/**
 * Refuses a request whose Idempotency-Key has already been used by this project.
 *
 * The key is claimed by inserting a row before the handler runs, so the unique
 * constraint on (projectId, key) — not a read-then-write check — is what decides
 * the race between two concurrent retries.
 *
 * The claim is released when the handler responds 4xx, because those errors are
 * raised before any contact, event, or email is written and the caller should be
 * free to fix the request and retry with the same key. It is *kept* on 2xx (the
 * request succeeded) and on 5xx (the request failed with side effects in an
 * unknown state, so a blind retry is exactly what this feature exists to stop).
 *
 * The claim is available to the handler as `res.locals.idempotency`.
 *
 * Must run after an auth middleware, which populates res.locals.auth.projectId.
 */
export const idempotency = createIdempotency({resumable: false});

/**
 * Like `idempotency`, for a route that can finish an earlier request's work without repeating it.
 * A key an earlier request to the same route claimed is not refused here: the handler receives the
 * claim as `res.locals.idempotency.reused` and either refuses the request (see `keyReused`) or
 * finishes the earlier request's work (see `claimUnfinished`). A handler that has started writing
 * sets `keepOnClientError`, so a 4xx no longer releases the claim.
 */
export const resumableIdempotency = createIdempotency({resumable: true});
