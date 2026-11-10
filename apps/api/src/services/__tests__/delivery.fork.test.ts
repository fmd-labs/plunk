import {randomUUID} from 'node:crypto';

import {EmailStatus} from '@plunk/db';
import {ActionSchemas} from '@plunk/shared';
import type {Request, Response} from 'express';
import {beforeEach, describe, expect, it} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {Actions} from '../../controllers/Actions';
import {recordTerminalFailure, unknownOutcome} from '../../jobs/email-processor';
import {sweepStalledEmails} from '../../jobs/email-stall-sweep-processor';
import {emailQueue, QueueService} from '../QueueService';
import {ThrottleService} from '../ThrottleService';
import {TransactionalSendService} from '../TransactionalSendService';

/**
 * Upstream's `delivery` options (0.18: `delivery.at`, `delivery.throttle`) on the fork's send path:
 * the batch endpoint (D20), retries under an idempotency key (D17), which failures release a
 * throttle claim (D07), and the stalled-email sweep's view of scheduled emails (D25).
 */
const HOUR = 60 * 60 * 1000;

type BatchResult = {status: string; email?: string | null; scheduledFor?: string; nextAllowedAt?: string | null};

function sendBatch(projectId: string, emails: unknown[]) {
  return new Promise<BatchResult[]>((resolve, reject) => {
    const res = {
      locals: {auth: {type: 'apiKey', projectId}},
      status() {
        return this;
      },
      json(payload: {data: {emails: BatchResult[]}}) {
        resolve(payload.data.emails);
        return this;
      },
    } as unknown as Response;
    new Actions().sendBatch({body: {emails}, headers: {}} as unknown as Request, res, error => reject(error));
  });
}

describe('delivery options on the fork send path', () => {
  const prisma = getPrismaClient();
  let projectId: string;
  const message = {subject: 'Your trial ends soon', body: '<p>Hi</p>', from: 'hello@example.com'};

  beforeEach(async () => {
    await emailQueue.obliterate({force: true});
    projectId = (await factories.createUserWithProject()).project.id;
    await factories.createDomain({projectId, domain: 'example.com'});
  });

  it('schedules and throttles the emails of a batch, and reports a scheduled duplicate with its time', async () => {
    const at = new Date(Date.now() + 2 * HOUR).toISOString();
    const throttle = {window: '24h', key: 'trial'};

    const first = await sendBatch(projectId, [
      {...message, to: 'ada@example.com', delivery: {at}, idempotencyKey: 'trial-ada'},
      {...message, to: 'bob@example.com', delivery: {throttle}},
      {...message, to: 'bob@example.com', delivery: {throttle}},
    ]);

    expect(first.map(result => result.status)).toEqual(['scheduled', 'queued', 'throttled']);
    expect(first[0]).toMatchObject({scheduledFor: at, email: expect.any(String)});
    expect(first[2]).toMatchObject({email: null, nextAllowedAt: expect.any(String)});
    const scheduled = await prisma.email.findUniqueOrThrow({where: {id: first[0]!.email!}});
    expect(scheduled.status).toBe(EmailStatus.SCHEDULED);
    expect(await (await emailQueue.getJob(`email-${scheduled.id}`))?.isDelayed()).toBe(true);

    const retried = await sendBatch(projectId, [
      {...message, to: 'ada@example.com', delivery: {at}, idempotencyKey: 'trial-ada'},
    ]);
    expect(retried[0]).toMatchObject({status: 'duplicate', email: scheduled.id, scheduledFor: at});
    expect(await prisma.email.count({where: {projectId}})).toBe(2);
  });

  it('reports a scheduled email of a request under an idempotency key as scheduled when it is replayed', async () => {
    const at = new Date(Date.now() + HOUR).toISOString();
    const request = ActionSchemas.send.parse({...message, to: ['ada@example.com', 'bob@example.com'], delivery: {at}});
    const claimId = randomUUID();

    const send = await TransactionalSendService.prepare(projectId, request);
    const sent = await TransactionalSendService.sendToAll(send, claimId);
    const replayed = await TransactionalSendService.findQueued(projectId, request, claimId);

    expect(sent.map(result => result.status)).toEqual(['scheduled', 'scheduled']);
    expect(replayed).toEqual(sent);
  });

  it('releases the throttle claim of an email that failed for good, and keeps it for an unknown outcome', async () => {
    const contact = await factories.createContact({projectId});
    const hold = async () => {
      const email = await factories.createEmail(projectId, contact.id, {status: EmailStatus.PENDING});
      const claim = await ThrottleService.claim(
        {projectId, key: `${email.id}:`, recipientKey: contact.id, contactId: contact.id},
        3600,
        new Date(),
      );
      if (!claim.claimed) throw new Error('not claimed');
      await ThrottleService.attachEmail(claim.claimId, email.id);
      return email;
    };
    const rejected = await hold();
    const unknown = await hold();

    await recordTerminalFailure(rejected, EmailStatus.PENDING, 'Email address is not verified');
    await recordTerminalFailure(unknown, EmailStatus.PENDING, unknownOutcome('the connection dropped'));

    expect(await prisma.throttleClaim.count({where: {emailId: rejected.id}})).toBe(0);
    expect(await prisma.throttleClaim.count({where: {emailId: unknown.id}})).toBe(1);
  });

  it('counts the age of a scheduled email from its time, not its creation', async () => {
    const contact = await factories.createContact({projectId});
    const created = await factories.createEmail(projectId, contact.id, {status: EmailStatus.PENDING});
    // Scheduled three days ahead, due 30 minutes ago; its job was lost after it became PENDING.
    await prisma.email.update({
      where: {id: created.id},
      data: {
        createdAt: new Date(Date.now() - 72 * HOUR),
        scheduledFor: new Date(Date.now() - 30 * 60_000),
        updatedAt: new Date(Date.now() - 20 * 60_000),
      },
    });

    const result = await sweepStalledEmails({settle: 10, ms: 10_000, maxAgeMs: 24 * HOUR});

    expect(result).toMatchObject({requeued: 1, closed: 0});
    expect((await prisma.email.findUniqueOrThrow({where: {id: created.id}})).status).toBe(EmailStatus.PENDING);
    expect(await emailQueue.getJob(`email-${created.id}`)).toBeDefined();
  });

  it('queues an overdue scheduled email again under its own job id, and leaves a job that still waits', async () => {
    const lost = randomUUID();
    const waiting = randomUUID();
    await emailQueue.add('send-email', {emailId: waiting}, {jobId: `email-${waiting}`, delay: HOUR});
    const before = (await emailQueue.getJob(`email-${waiting}`))!.timestamp;

    await QueueService.requeueScheduledEmail(lost);
    await QueueService.requeueScheduledEmail(waiting);

    expect(await emailQueue.getJob(`email-${lost}`)).toBeDefined();
    const kept = (await emailQueue.getJob(`email-${waiting}`))!;
    expect(await kept.isDelayed()).toBe(true);
    expect(kept.timestamp).toBe(before);
  });
});
