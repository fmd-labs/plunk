import type {Request, Response} from 'express';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ZodError} from 'zod';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {ErrorCode, HttpException, ValidationError} from '../../exceptions';
import {BillingLimitService} from '../../services/BillingLimitService';
import {ContactService} from '../../services/ContactService';
import {emailQueue, QueueService} from '../../services/QueueService';
import {Actions} from '../Actions';

interface BatchResponse {
  success: boolean;
  data: {
    emails: (
      | {status: 'queued' | 'duplicate'; email: string; contact: {id: string; email: string}}
      | {status: 'failed'; error: {code: string; message: string; retryable: boolean}}
    )[];
    timestamp: string;
  };
}

type BatchOutcome = {status: number; body: BatchResponse} | {error: unknown};

/**
 * Call the handler and settle on whichever it does: answer, or hand an error to `next`.
 * `CatchAsync` does not return the handler's promise, so awaiting the call would not wait for it.
 */
function sendBatch(projectId: string, emails: unknown[], headers: Record<string, string> = {}) {
  return new Promise<BatchOutcome>(resolve => {
    let status = 200;
    const res = {
      locals: {auth: {type: 'apiKey', projectId}},
      status(code: number) {
        status = code;
        return this;
      },
      json(payload: BatchResponse) {
        resolve({status, body: payload});
        return this;
      },
    } as unknown as Response;
    new Actions().sendBatch({body: {emails}, headers} as unknown as Request, res, error => resolve({error}));
  });
}

function results(outcome: BatchOutcome) {
  if ('error' in outcome) throw outcome.error;
  return outcome.body.data.emails;
}

function errorOf(outcome: BatchOutcome) {
  if (!('error' in outcome)) throw new Error(`Expected the request to fail, but it answered ${outcome.status}`);
  return outcome.error;
}

describe('POST /v1/send/batch', () => {
  const prisma = getPrismaClient();
  let projectId: string;

  const message = {subject: 'Your weekly summary', body: '<p>News</p>', from: 'summary@example.com'};

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
    await factories.createDomain({projectId, domain: 'example.com'});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function countEmails() {
    return prisma.email.count({where: {projectId}});
  }

  it('queues each email and reports it, in order', async () => {
    const outcome = await sendBatch(projectId, [
      {...message, to: 'ada@example.com'},
      {...message, to: {name: 'Grace', email: 'grace@example.com'}, priority: 'low'},
      {...message, to: 'linus@example.com', subject: 'Hi {{name}}', templating: false},
    ]);

    const emails = results(outcome);
    expect(emails).toEqual([
      {status: 'queued', email: expect.any(String), contact: {id: expect.any(String), email: 'ada@example.com'}},
      {status: 'queued', email: expect.any(String), contact: {id: expect.any(String), email: 'grace@example.com'}},
      {status: 'queued', email: expect.any(String), contact: {id: expect.any(String), email: 'linus@example.com'}},
    ]);
    const ids = emails.map(result => ('email' in result ? result.email : ''));
    const priorities = await Promise.all(ids.map(async id => (await emailQueue.getJob(`email-${id}`))?.opts.priority));
    expect(priorities).toEqual([1, 10, 1]);
    expect(await prisma.email.findUniqueOrThrow({where: {id: ids[2]}})).toMatchObject({
      subject: 'Hi {{name}}',
      toName: null,
    });
    expect(await prisma.email.findUniqueOrThrow({where: {id: ids[1]}})).toMatchObject({toName: 'Grace'});
  });

  it('reports an email whose key an earlier batch used as a duplicate, and sends it once', async () => {
    const first = results(
      await sendBatch(projectId, [
        {...message, to: 'ada@example.com', idempotencyKey: 'summary-ada'},
        {...message, to: 'grace@example.com', idempotencyKey: 'summary-grace'},
      ]),
    );

    const retry = results(
      await sendBatch(projectId, [
        {...message, to: 'grace@example.com', idempotencyKey: 'summary-grace'},
        {...message, to: 'linus@example.com', idempotencyKey: 'summary-linus'},
      ]),
    );

    expect(retry).toEqual([
      {...first[1], status: 'duplicate'},
      {status: 'queued', email: expect.any(String), contact: {id: expect.any(String), email: 'linus@example.com'}},
    ]);
    expect(await countEmails()).toBe(3);
  });

  it('reports an email whose key an earlier batch used as a duplicate, whoever it is to', async () => {
    const [first] = results(await sendBatch(projectId, [{...message, to: 'ada@example.com', idempotencyKey: 'k'}]));

    const [retry] = results(await sendBatch(projectId, [{...message, to: 'grace@example.com', idempotencyKey: 'k'}]));

    expect(retry).toEqual({...first, status: 'duplicate'});
    expect(await countEmails()).toBe(1);
  });

  it('sends an email it could not queue on a retry with its key, once', async () => {
    vi.spyOn(QueueService, 'queueEmail').mockRejectedValueOnce(new Error('queue unavailable'));
    const usage = vi.spyOn(BillingLimitService, 'incrementUsage');
    const batch = [{...message, to: 'ada@example.com', idempotencyKey: 'k'}];

    const [failed] = results(await sendBatch(projectId, batch));
    expect(failed).toEqual({
      status: 'failed',
      error: {code: ErrorCode.INTERNAL_SERVER_ERROR, message: 'The email could not be sent', retryable: true},
    });

    const [retry] = results(await sendBatch(projectId, batch));

    expect(retry).toMatchObject({status: 'duplicate', contact: {email: 'ada@example.com'}});
    const id = retry && 'email' in retry ? retry.email : '';
    expect(await emailQueue.getJob(`email-${id}`)).toBeDefined();
    expect(await countEmails()).toBe(1);
    expect(usage).toHaveBeenCalledOnce();
  });

  it('refuses the Idempotency-Key header, which would read as covering the batch', async () => {
    const error = errorOf(await sendBatch(projectId, [{...message, to: 'ada@example.com'}], {'idempotency-key': 'k'}));

    expect(error).toBeInstanceOf(HttpException);
    expect(error).toMatchObject({code: 400, errorCode: ErrorCode.BAD_REQUEST});
    expect(await countEmails()).toBe(0);
  });

  it('queues again the email of a key whose email is still waiting without its job', async () => {
    const [first] = results(await sendBatch(projectId, [{...message, to: 'ada@example.com', idempotencyKey: 'k'}]));
    const id = first && 'email' in first ? first.email : '';
    await emailQueue.remove(`email-${id}`);

    const [retry] = results(await sendBatch(projectId, [{...message, to: 'ada@example.com', idempotencyKey: 'k'}]));

    expect(retry).toMatchObject({status: 'duplicate', email: id});
    expect(await emailQueue.getJob(`email-${id}`)).toBeDefined();
  });

  it('sends an email once when two batches with its key arrive together', async () => {
    const batch = [{...message, to: 'ada@example.com', idempotencyKey: 'k'}];

    const outcomes = await Promise.all([sendBatch(projectId, batch), sendBatch(projectId, batch)]);

    const statuses = outcomes.flatMap(outcome => results(outcome).map(result => result.status)).sort();
    expect(statuses).toEqual(['duplicate', 'queued']);
    expect(await countEmails()).toBe(1);
  });

  it('reports an email that fails, and sends the rest', async () => {
    vi.spyOn(BillingLimitService, 'checkLimit')
      .mockResolvedValueOnce({allowed: true, warning: false, usage: 0, limit: null, percentage: 0})
      .mockResolvedValueOnce({
        allowed: false,
        warning: false,
        usage: 100,
        limit: 100,
        percentage: 100,
        message: 'Transactional limit reached',
      })
      .mockResolvedValueOnce({allowed: true, warning: false, usage: 0, limit: null, percentage: 0});

    const emails = results(
      await sendBatch(projectId, [
        {...message, to: 'ada@example.com'},
        {...message, to: 'grace@example.com'},
        {...message, to: 'linus@example.com'},
      ]),
    );

    expect(emails.map(result => result.status)).toEqual(['queued', 'failed', 'queued']);
    expect(emails[1]).toEqual({
      status: 'failed',
      error: {code: ErrorCode.BILLING_LIMIT_EXCEEDED, message: 'Transactional limit reached', retryable: true},
    });
    expect(await countEmails()).toBe(2);
  });

  it('reports a failure on its own side without its message', async () => {
    vi.spyOn(ContactService, 'upsert').mockRejectedValueOnce(
      new HttpException(500, 'Failed to create contact: connection to 10.0.0.5:5432 refused'),
    );

    const [failed] = results(await sendBatch(projectId, [{...message, to: 'ada@example.com'}]));

    expect(failed).toEqual({
      status: 'failed',
      error: {code: ErrorCode.INTERNAL_SERVER_ERROR, message: 'The email could not be sent', retryable: true},
    });
  });

  it('sends a failed email with its key on a retry', async () => {
    const template = await factories.createTemplate({projectId, from: 'summary@example.com', type: 'MARKETING'});
    const contact = await factories.createContact({projectId, email: 'ada@example.com', subscribed: false});
    const batch = [{to: 'ada@example.com', template: template.id, idempotencyKey: 'k'}];

    const [refused] = results(await sendBatch(projectId, batch));
    expect(refused).toMatchObject({status: 'failed', error: {code: ErrorCode.BAD_REQUEST, retryable: false}});

    await prisma.contact.update({where: {id: contact.id}, data: {subscribed: true}});
    const [retry] = results(await sendBatch(projectId, batch));

    expect(retry).toMatchObject({status: 'queued', contact: {id: contact.id}});
    expect(await countEmails()).toBe(1);
  });

  it('refuses a batch with an email that cannot be sent, and sends none', async () => {
    const error = errorOf(
      await sendBatch(projectId, [
        {...message, to: 'ada@example.com'},
        {...message, to: 'grace@example.com', from: 'news@unverified.example'},
        {...message, to: 'linus@example.com', template: '00000000-0000-4000-8000-000000000000'},
      ]),
    );

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).errors).toEqual([
      expect.objectContaining({
        field: 'emails.1',
        code: ErrorCode.FORBIDDEN,
        message: expect.stringContaining('unverified.example'),
      }),
      expect.objectContaining({field: 'emails.2', code: ErrorCode.TEMPLATE_NOT_FOUND}),
    ]);
    expect(await countEmails()).toBe(0);
  });

  it('refuses invalid emails, naming each', async () => {
    const error = errorOf(
      await sendBatch(projectId, [
        {...message, to: ['ada@example.com', 'grace@example.com']},
        {...message, to: 'grace@example.com', subject: undefined},
        {...message, to: 'linus@example.com'},
      ]),
    );

    expect(error).toBeInstanceOf(ZodError);
    expect((error as ZodError).issues.map(issue => issue.path.join('.'))).toEqual(['emails.0.to', 'emails.1.template']);
    expect(await countEmails()).toBe(0);
  });

  it('refuses two emails with the same key', async () => {
    const error = errorOf(
      await sendBatch(projectId, [
        {...message, to: 'linus@example.com', idempotencyKey: 'k'},
        {...message, to: 'ken@example.com', idempotencyKey: 'k'},
      ]),
    );

    expect((error as ZodError).issues).toEqual([expect.objectContaining({path: ['emails', 1, 'idempotencyKey']})]);
  });

  it('takes at most 100 emails', async () => {
    const emails = Array.from({length: 101}, (_, index) => ({...message, to: `r${index}@example.com`}));

    expect(errorOf(await sendBatch(projectId, emails))).toBeInstanceOf(ZodError);
    expect(await countEmails()).toBe(0);
  });
});
