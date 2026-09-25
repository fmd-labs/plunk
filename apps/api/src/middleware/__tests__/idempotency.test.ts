import type {Request, Response} from 'express';
import {EventEmitter} from 'node:events';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {ErrorCode, HttpException} from '../../exceptions/index.js';
import {
  claimUnfinished,
  IN_FLIGHT_MS,
  type IdempotencyContext,
  idempotency,
  resumableIdempotency,
} from '../idempotency.js';

/**
 * Minimal Response stand-in: the middleware only needs res.locals and the
 * 'finish' event, which it uses to settle the claim once the handler responds.
 */
function createResponse(projectId: string) {
  const res = new EventEmitter() as unknown as Response & {statusCode: number};
  res.locals = {auth: {type: 'secret', projectId}};
  res.statusCode = 200;
  return res;
}

/** A request as Express hands it to a controller mounted at `/v1`: the path is the router's. */
function createRequest(key?: string): Request {
  return {
    method: 'POST',
    baseUrl: '/v1',
    path: '/send',
    headers: key === undefined ? {} : {'idempotency-key': key},
  } as unknown as Request;
}

/** Resolve once the middleware calls next(), returning whatever it passed. */
function run(req: Request, res: Response): Promise<unknown> {
  return new Promise(resolve => {
    void idempotency(req, res, (error?: unknown) => resolve(error) as unknown as void);
  });
}

/** Like `run`, through the resumable variant. */
function runResumable(req: Request, res: Response): Promise<unknown> {
  return new Promise(resolve => {
    void resumableIdempotency(req, res, (error?: unknown) => resolve(error) as unknown as void);
  });
}

/** The claim is settled in a 'finish' listener that we deliberately do not await. */
async function respond(res: Response & {statusCode: number}, statusCode: number) {
  res.statusCode = statusCode;
  res.emit('finish');
  await vi.waitFor(async () => {
    // Settled means the row is either gone (4xx) or has a statusCode written.
    const rows = await getPrismaClient().idempotencyKey.findMany({where: {statusCode: null}});
    expect(rows).toHaveLength(0);
  });
}

describe('Idempotency Middleware', () => {
  const prisma = getPrismaClient();
  let projectId: string;

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
  });

  it('is a no-op when no Idempotency-Key header is present', async () => {
    const error = await run(createRequest(), createResponse(projectId));

    expect(error).toBeUndefined();
    expect(await prisma.idempotencyKey.count()).toBe(0);
  });

  it('claims the key before the handler runs', async () => {
    const error = await run(createRequest('key-alpha'), createResponse(projectId));

    expect(error).toBeUndefined();

    const claim = await prisma.idempotencyKey.findUniqueOrThrow({
      where: {projectId_key: {projectId, key: 'key-alpha'}},
    });
    expect(claim.method).toBe('POST');
    expect(claim.path).toBe('/v1/send');
    // Null until the response settles the claim
    expect(claim.statusCode).toBeNull();
    expect(claim.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('refuses a reused key with 409', async () => {
    const first = createResponse(projectId);
    await run(createRequest('key-reused'), first);
    await respond(first, 200);

    const error = await run(createRequest('key-reused'), createResponse(projectId));

    expect(error).toBeInstanceOf(HttpException);
    const httpError = error as HttpException;
    expect(httpError.code).toBe(409);
    expect(httpError.errorCode).toBe(ErrorCode.IDEMPOTENCY_KEY_REUSED);
    expect(httpError.details).toMatchObject({
      key: 'key-reused',
      originalRequest: 'POST /v1/send',
      originalStatusCode: 200,
    });
  });

  it('refuses a reused key while the original request is still in flight', async () => {
    // No respond() call: the first claim is unsettled, mimicking a concurrent retry
    await run(createRequest('key-inflight'), createResponse(projectId));

    const error = await run(createRequest('key-inflight'), createResponse(projectId));

    expect((error as HttpException).code).toBe(409);
    expect((error as HttpException).details).toMatchObject({originalStatusCode: null});
  });

  it('scopes keys to a project, so a different project may reuse the same key', async () => {
    await run(createRequest('key-shared'), createResponse(projectId));

    const {project: other} = await factories.createUserWithProject();
    const error = await run(createRequest('key-shared'), createResponse(other.id));

    expect(error).toBeUndefined();
    expect(await prisma.idempotencyKey.count({where: {key: 'key-shared'}})).toBe(2);
  });

  it('releases the claim on a 4xx so the caller can fix the request and retry', async () => {
    const res = createResponse(projectId);
    await run(createRequest('key-4xx'), res);
    await respond(res, 422);

    expect(await prisma.idempotencyKey.count({where: {key: 'key-4xx'}})).toBe(0);

    // The same key is now free
    const retry = await run(createRequest('key-4xx'), createResponse(projectId));
    expect(retry).toBeUndefined();
  });

  it('keeps the claim on a 5xx, because side effects are in an unknown state', async () => {
    const res = createResponse(projectId);
    await run(createRequest('key-5xx'), res);
    await respond(res, 500);

    const claim = await prisma.idempotencyKey.findUniqueOrThrow({
      where: {projectId_key: {projectId, key: 'key-5xx'}},
    });
    expect(claim.statusCode).toBe(500);

    const retry = await run(createRequest('key-5xx'), createResponse(projectId));
    expect((retry as HttpException).code).toBe(409);
  });

  it.each([
    ['an empty key', ''],
    ['a key over 255 characters', 'k'.repeat(256)],
    ['a key with non-printable characters', 'key\nwith-newline'],
  ])('rejects %s with 400', async (_label, key) => {
    const error = await run(createRequest(key), createResponse(projectId));

    expect((error as HttpException).code).toBe(400);
    expect(await prisma.idempotencyKey.count()).toBe(0);
  });
});

describe('Resumable idempotency middleware', () => {
  const prisma = getPrismaClient();
  let projectId: string;

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
  });

  function claimed(key: string) {
    return prisma.idempotencyKey.findUniqueOrThrow({where: {projectId_key: {projectId, key}}});
  }

  /** A key an earlier request to the same endpoint claimed and answered with `statusCode`. */
  async function usedKey(key: string, statusCode: number) {
    const res = createResponse(projectId);
    await runResumable(createRequest(key), res);
    await respond(res, statusCode);
  }

  it('gives the handler the claim it made', async () => {
    const res = createResponse(projectId);

    expect(await runResumable(createRequest('key-new'), res)).toBeUndefined();

    expect(res.locals.idempotency).toEqual({key: 'key-new', claimId: (await claimed('key-new')).id});
  });

  it('hands a key an earlier request to the same endpoint used to the handler instead of refusing it', async () => {
    await usedKey('key-reused', 500);
    const res = createResponse(projectId);

    expect(await runResumable(createRequest('key-reused'), res)).toBeUndefined();

    const claim = await claimed('key-reused');
    expect(res.locals.idempotency).toEqual({
      key: 'key-reused',
      claimId: claim.id,
      reused: {id: claim.id, method: 'POST', path: '/v1/send', createdAt: claim.createdAt, statusCode: 500},
    });
  });

  it('refuses a key an earlier request used on another endpoint', async () => {
    await run({...createRequest('key-track'), path: '/track'} as Request, createResponse(projectId));

    const error = await runResumable(createRequest('key-track'), createResponse(projectId));

    expect(error).toBeInstanceOf(HttpException);
    expect(error).toMatchObject({code: 409, details: {originalRequest: 'POST /v1/track'}});
  });

  it('records the success of a request that finished the work of an earlier one', async () => {
    await usedKey('key-resumed', 500);
    const retry = createResponse(projectId);
    await runResumable(createRequest('key-resumed'), retry);

    retry.statusCode = 200;
    retry.emit('finish');

    await vi.waitFor(async () => {
      expect((await claimed('key-resumed')).statusCode).toBe(200);
    });
  });

  it("leaves an earlier request's claim as it was when a retry does not succeed", async () => {
    await usedKey('key-kept', 500);

    for (const statusCode of [409, 422, 503]) {
      const retry = createResponse(projectId);
      await runResumable(createRequest('key-kept'), retry);
      retry.statusCode = statusCode;
      retry.emit('finish');
    }
    // Nothing is written, so there is nothing to wait for; give a stray write time to land.
    await new Promise(resolve => setTimeout(resolve, 100));

    expect((await claimed('key-kept')).statusCode).toBe(500);
  });

  it('takes over a claim made before paths were stored with their prefix', async () => {
    await prisma.idempotencyKey.create({
      data: {projectId, key: 'key-legacy', method: 'POST', path: '/send', statusCode: 500, expiresAt: new Date(Date.now() + 3_600_000)},
    });
    const res = createResponse(projectId);

    expect(await runResumable(createRequest('key-legacy'), res)).toBeUndefined();

    expect((res.locals.idempotency as IdempotencyContext).reused).toMatchObject({path: '/send', statusCode: 500});
  });

  it('claims anew a key whose claim expired and has not been removed yet', async () => {
    const expired = await prisma.idempotencyKey.create({
      data: {projectId, key: 'key-expired', method: 'POST', path: '/v1/send', statusCode: 200, expiresAt: new Date(Date.now() - 1000)},
    });
    const res = createResponse(projectId);

    expect(await runResumable(createRequest('key-expired'), res)).toBeUndefined();

    const claim = await claimed('key-expired');
    expect(claim.id).not.toBe(expired.id);
    expect(res.locals.idempotency).toEqual({key: 'key-expired', claimId: claim.id});
  });

  it('keeps a claim that a retry settled when the request that made it answers 4xx later', async () => {
    const first = createResponse(projectId);
    await runResumable(createRequest('key-late'), first);
    // A retry took the claim over after the first request went quiet, and succeeded.
    await prisma.idempotencyKey.update({where: {id: (await claimed('key-late')).id}, data: {statusCode: 200}});

    first.statusCode = 422;
    first.emit('finish');
    await new Promise(resolve => setTimeout(resolve, 100));

    expect((await claimed('key-late')).statusCode).toBe(200);
  });

  it('keeps the claim on a 4xx once the handler has started writing', async () => {
    const res = createResponse(projectId);
    await runResumable(createRequest('key-started'), res);
    (res.locals.idempotency as IdempotencyContext).keepOnClientError = true;

    await respond(res, 400);

    expect((await claimed('key-started')).statusCode).toBe(400);
  });
});

describe('claimUnfinished', () => {
  const claim = {id: 'claim', method: 'POST', path: '/v1/send', createdAt: new Date('2026-01-01T00:00:00Z')};

  it.each([
    {statusCode: null, age: 0, unfinished: false},
    {statusCode: null, age: IN_FLIGHT_MS - 1, unfinished: false},
    {statusCode: null, age: IN_FLIGHT_MS, unfinished: true},
    {statusCode: 200, age: 0, unfinished: false},
    {statusCode: 201, age: IN_FLIGHT_MS, unfinished: false},
    {statusCode: 400, age: 0, unfinished: true},
    {statusCode: 500, age: 0, unfinished: true},
  ])('reads a claim answered $statusCode, $age ms old, as unfinished: $unfinished', ({statusCode, age, unfinished}) => {
    expect(claimUnfinished({...claim, statusCode}, claim.createdAt.getTime() + age)).toBe(unfinished);
  });
});
