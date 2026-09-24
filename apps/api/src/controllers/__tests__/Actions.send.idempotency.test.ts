import {EmailStatus, TemplateType} from '@plunk/db';
import type {Request, Response} from 'express';
import {EventEmitter} from 'node:events';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ZodError} from 'zod';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {ErrorCode, HttpException} from '../../exceptions';
import {resumableIdempotency} from '../../middleware/idempotency';
import {BillingLimitService} from '../../services/BillingLimitService';
import {emailQueue, QueueService} from '../../services/QueueService';
import {TransactionalSendService} from '../../services/TransactionalSendService';
import {Actions} from '../Actions';

/**
 * POST /v1/send with an Idempotency-Key: the middleware and the handler run in sequence, as the
 * router runs them, and the response is finished with the status the error handler would give.
 */

interface QueuedEmail {
  contact: {id: string; email: string};
  email: string;
}

type Outcome = {status: number; emails: QueuedEmail[]} | {status: number; error: unknown};

function statusOf(error: unknown) {
  if (error instanceof HttpException) return error.code;
  if (error instanceof ZodError) return 422;
  return 500;
}

async function send(projectId: string, body: unknown, key?: string): Promise<Outcome> {
  const req = {
    method: 'POST',
    path: '/v1/send',
    headers: key === undefined ? {} : {'idempotency-key': key},
    body,
  } as unknown as Request;
  const res = new EventEmitter() as unknown as Response & {statusCode: number};
  res.locals = {auth: {type: 'secret', projectId}};
  res.statusCode = 200;

  const outcome = await new Promise<Outcome>(resolve => {
    res.status = (code: number) => {
      res.statusCode = code;
      return res;
    };
    res.json = (payload: {data: {emails: QueuedEmail[]}}) => {
      resolve({status: res.statusCode, emails: payload.data.emails});
      return res;
    };
    const fail = (error: unknown) => resolve({status: statusOf(error), error});

    void resumableIdempotency(req, res, (error?: unknown) => {
      if (error) {
        fail(error);
        return;
      }
      new Actions().send(req, res, fail);
    });
  });

  res.statusCode = outcome.status;
  res.emit('finish');
  return outcome;
}

function emailsOf(outcome: Outcome) {
  if ('error' in outcome) throw outcome.error;
  return outcome.emails;
}

function errorOf(outcome: Outcome) {
  if (!('error' in outcome)) throw new Error(`Expected the request to fail, but it answered ${outcome.status}`);
  return outcome.error;
}

describe('POST /v1/send with an Idempotency-Key', () => {
  const prisma = getPrismaClient();
  let projectId: string;

  const message = {subject: 'Your receipt', body: '<p>Thanks!</p>', from: 'receipts@example.com'};

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
    await factories.createDomain({projectId, domain: 'example.com'});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** The key's claim once the request's answer has settled it (the settle is not awaited). */
  async function settledClaim(key: string, statusCode: number) {
    return vi.waitFor(async () => {
      const claim = await prisma.idempotencyKey.findUniqueOrThrow({where: {projectId_key: {projectId, key}}});
      expect(claim.statusCode).toBe(statusCode);
      return claim;
    });
  }

  /** Make the key's claim look as if its request were still running, or had died `ageMs` ago. */
  async function unanswered(key: string, ageMs: number) {
    await prisma.idempotencyKey.update({
      where: {projectId_key: {projectId, key}},
      data: {statusCode: null, createdAt: new Date(Date.now() - ageMs)},
    });
  }

  function countEmails() {
    return prisma.email.count({where: {projectId}});
  }

  it('derives the email ids from the claim, and refuses a retry with the emails already queued', async () => {
    const body = {...message, to: ['ada@example.com', 'grace@example.com']};

    const emails = emailsOf(await send(projectId, body, 'order-1'));
    const claim = await settledClaim('order-1', 200);

    expect(emails.map(({email}) => email)).toEqual(
      TransactionalSendService.emailIds(claim.id, [{email: 'ada@example.com'}, {email: 'grace@example.com'}]),
    );

    const retry = errorOf(await send(projectId, body, 'order-1'));

    expect(retry).toBeInstanceOf(HttpException);
    expect(retry).toMatchObject({
      code: 409,
      errorCode: ErrorCode.IDEMPOTENCY_KEY_REUSED,
      details: {key: 'order-1', originalRequest: 'POST /v1/send', originalStatusCode: 200, emails},
    });
    expect(await countEmails()).toBe(2);
  });

  it('refuses a retry while the first request is in flight, with the emails it has queued so far', async () => {
    const body = {...message, to: ['ada@example.com', 'grace@example.com']};
    const [first, second] = emailsOf(await send(projectId, body, 'order-1'));
    await settledClaim('order-1', 200);
    // Still running, and only as far as the first recipient.
    await unanswered('order-1', 1_000);
    await prisma.email.delete({where: {id: second!.email}});

    const retry = errorOf(await send(projectId, body, 'order-1'));

    expect(retry).toMatchObject({code: 409, details: {originalStatusCode: null, emails: [first]}});
    expect(await countEmails()).toBe(1);
  });

  it.each([
    {case: 'died without answering', statusCode: null, ageMs: 31_000},
    {case: 'failed with a 5xx', statusCode: 500, ageMs: 0},
  ])('finishes the work of a first request that $case, queueing only what it had not', async ({statusCode, ageMs}) => {
    const body = {...message, to: ['ada@example.com', 'grace@example.com']};
    const emails = emailsOf(await send(projectId, body, 'order-1'));
    await settledClaim('order-1', 200);
    await prisma.idempotencyKey.update({
      where: {projectId_key: {projectId, key: 'order-1'}},
      data: {statusCode, createdAt: new Date(Date.now() - ageMs)},
    });
    await prisma.email.delete({where: {id: emails[1]!.email}});
    const kept = await prisma.email.findUniqueOrThrow({where: {id: emails[0]!.email}});
    const limitChecks = vi.spyOn(BillingLimitService, 'checkLimit');

    const retry = emailsOf(await send(projectId, body, 'order-1'));

    expect(retry).toEqual(emails);
    expect(await countEmails()).toBe(2);
    // The email already queued is reported as it is, without being checked or written again.
    expect(await prisma.email.findUniqueOrThrow({where: {id: emails[0]!.email}})).toEqual(kept);
    expect(limitChecks).toHaveBeenCalledOnce();
    expect(await emailQueue.getJob(`email-${emails[1]!.email}`)).toBeDefined();
    await settledClaim('order-1', 200);
  });

  it('finds the same emails when a retry lists the recipients in another order', async () => {
    const [ada, grace] = emailsOf(
      await send(projectId, {...message, to: ['ada@example.com', 'grace@example.com']}, 'k'),
    );
    await settledClaim('k', 200);
    await unanswered('k', 31_000);

    const retry = emailsOf(await send(projectId, {...message, to: ['GRACE@example.com', 'ada@example.com']}, 'k'));

    expect(retry).toEqual([grace, ada]);
    expect(await countEmails()).toBe(2);
  });

  it('gives each listing of a repeated address its own email', async () => {
    const emails = emailsOf(await send(projectId, {...message, to: ['ada@example.com', 'ada@example.com']}, 'k'));
    await settledClaim('k', 200);

    expect(new Set(emails.map(({email}) => email)).size).toBe(2);
    expect(errorOf(await send(projectId, {...message, to: ['ada@example.com', 'ada@example.com']}, 'k'))).toMatchObject(
      {details: {emails}},
    );
  });

  it('keeps the key when a later recipient is refused, so a retry after the fix sends only the rest', async () => {
    const template = await factories.createTemplate({
      projectId,
      from: 'news@example.com',
      type: TemplateType.MARKETING,
    });
    const subscribed = await factories.createContact({projectId, email: 'ada@example.com', subscribed: true});
    const unsubscribed = await factories.createContact({projectId, email: 'grace@example.com', subscribed: false});
    const body = {to: ['ada@example.com', 'grace@example.com'], template: template.id};

    expect(errorOf(await send(projectId, body, 'k'))).toMatchObject({code: 400});
    await settledClaim('k', 400);
    const [queued] = await prisma.email.findMany({where: {projectId}});
    expect(queued?.contactId).toBe(subscribed.id);

    await prisma.contact.update({where: {id: unsubscribed.id}, data: {subscribed: true}});
    const retry = emailsOf(await send(projectId, body, 'k'));

    expect(retry.map(({contact}) => contact.id)).toEqual([subscribed.id, unsubscribed.id]);
    expect(retry[0]!.email).toBe(queued!.id);
    expect(await countEmails()).toBe(2);
    await settledClaim('k', 200);
  });

  it('releases the key when the request is refused before any email is written', async () => {
    const refused = errorOf(
      await send(projectId, {to: 'ada@example.com', template: '00000000-0000-4000-8000-000000000000'}, 'k'),
    );

    expect(refused).toMatchObject({code: 404});
    await vi.waitFor(async () => {
      expect(await prisma.idempotencyKey.count({where: {projectId}})).toBe(0);
    });
    expect(emailsOf(await send(projectId, {...message, to: 'ada@example.com'}, 'k'))).toHaveLength(1);
  });

  it('removes an email it could not queue, and a retry with the key sends it', async () => {
    vi.spyOn(QueueService, 'queueEmail').mockRejectedValueOnce(new Error('queue unavailable'));

    const failed = await send(projectId, {...message, to: 'ada@example.com'}, 'k');

    expect(failed).toMatchObject({status: 500});
    expect(await countEmails()).toBe(0);
    await settledClaim('k', 500);

    const [email] = emailsOf(await send(projectId, {...message, to: 'ada@example.com'}, 'k'));

    expect(await prisma.email.findUniqueOrThrow({where: {id: email!.email}})).toMatchObject({
      status: EmailStatus.PENDING,
    });
    expect(await emailQueue.getJob(`email-${email!.email}`)).toBeDefined();
  });

  it('refuses a key the project used on another endpoint', async () => {
    await prisma.idempotencyKey.create({
      data: {projectId, key: 'k', method: 'POST', path: '/v1/track', expiresAt: new Date(Date.now() + 60_000)},
    });

    const refused = errorOf(await send(projectId, {...message, to: 'ada@example.com'}, 'k'));

    expect(refused).toMatchObject({code: 409, details: {originalRequest: 'POST /v1/track'}});
    expect((refused as HttpException).details).not.toHaveProperty('emails');
    expect(await countEmails()).toBe(0);
  });

  it('generates new ids for each request without a key', async () => {
    const [first] = emailsOf(await send(projectId, {...message, to: 'ada@example.com'}));
    const [second] = emailsOf(await send(projectId, {...message, to: 'ada@example.com'}));

    expect(first!.email).not.toBe(second!.email);
    expect(await countEmails()).toBe(2);
  });
});
