import {type Email, EmailSourceType, EmailStatus} from '@plunk/db';
import {toPrismaJson} from '@plunk/types';
import {Worker} from 'bullmq';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {emailQueue, QueueService} from '../../services/QueueService.js';
import {sweepStalledEmails} from '../email-processor';

describe('sweepStalledEmails', () => {
  const prisma = getPrismaClient();
  let projectId: string;
  let contactId: string;

  beforeEach(async () => {
    await emailQueue.obliterate({force: true});
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
    contactId = (await factories.createContact({projectId})).id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** An email last touched `minutes` ago. */
  async function email(status: EmailStatus, minutes = 16, headers?: Record<string, string>) {
    const created = await factories.createEmail(projectId, contactId, {status});
    return prisma.email.update({
      where: {id: created.id},
      data: {
        updatedAt: new Date(Date.now() - minutes * 60_000),
        ...(headers ? {headers: toPrismaJson(headers)} : {}),
      },
    });
  }

  function stored(emailId: string) {
    return prisma.email.findUniqueOrThrow({where: {id: emailId}});
  }

  function failedEvent(emailId: string) {
    return prisma.event.findFirst({where: {emailId, name: 'email.failed'}});
  }

  /** Take the email's job as a worker would, and end it for good with `end`. */
  async function finish(stalled: Email, end: 'completed' | 'failed', data?: Record<string, unknown>) {
    await emailQueue.add(
      'send-email',
      {emailId: stalled.id, ...data},
      {jobId: `email-${stalled.id}`, priority: 1, attempts: 1},
    );
    const worker = new Worker(emailQueue.name, null, {connection: emailQueue.opts.connection, autorun: false});
    try {
      const job = (await worker.getNextJob('test-token', {block: false}))!;
      if (end === 'completed') {
        await job.moveToCompleted(undefined, 'test-token', false);
      } else {
        await job.moveToFailed(new Error('SES unavailable'), 'test-token');
      }
    } finally {
      await worker.close();
    }
  }

  async function stateOf(emailId: string) {
    return (await emailQueue.getJob(`email-${emailId}`))?.getState();
  }

  it('queues again an email left PENDING without a job, with the priority it was sent with', async () => {
    const stalled = await email(EmailStatus.PENDING, 16, {'X-Plunk-Priority': 'low'});

    expect(await sweepStalledEmails(10)).toEqual({requeued: 1, settled: 0});

    const job = await emailQueue.getJob(`email-${stalled.id}`);
    expect(job?.data).toEqual({emailId: stalled.id});
    expect(job?.opts.priority).toBe(10);
  });

  it('leaves an email whose job is still waiting, or waiting to be retried', async () => {
    const waiting = await email(EmailStatus.PENDING);
    const delayed = await email(EmailStatus.SENDING);
    await QueueService.queueEmail(waiting.id, EmailSourceType.TRANSACTIONAL);
    await QueueService.queueEmail(delayed.id, EmailSourceType.TRANSACTIONAL, 60_000);

    expect(await sweepStalledEmails(10)).toEqual({requeued: 0, settled: 0});

    expect(await stored(delayed.id)).toMatchObject({status: EmailStatus.SENDING});
    expect(await stateOf(delayed.id)).toBe('delayed');
  });

  it('leaves an email touched in the last 15 minutes', async () => {
    const recent = await email(EmailStatus.PENDING, 14);

    expect(await sweepStalledEmails(10)).toEqual({requeued: 0, settled: 0});

    expect(await emailQueue.getJob(`email-${recent.id}`)).toBeUndefined();
  });

  it("fails an email whose job failed for good, with the job's error", async () => {
    const stalled = await email(EmailStatus.PENDING);
    await finish(stalled, 'failed');

    expect(await sweepStalledEmails(10)).toEqual({requeued: 0, settled: 1});

    expect(await stored(stalled.id)).toMatchObject({status: EmailStatus.FAILED, error: 'SES unavailable'});
    expect((await failedEvent(stalled.id))?.data).toMatchObject({reason: 'attempts_exhausted', attempts: 1});
  });

  it('queues again a PENDING email whose job completed without settling it', async () => {
    const stalled = await email(EmailStatus.PENDING);
    await finish(stalled, 'completed');

    expect(await sweepStalledEmails(10)).toEqual({requeued: 1, settled: 0});

    expect(await stateOf(stalled.id)).toBe('prioritized');
  });

  it('fails an email left SENDING without a job as an unknown outcome', async () => {
    const stalled = await email(EmailStatus.SENDING);

    expect(await sweepStalledEmails(10)).toEqual({requeued: 0, settled: 1});

    expect(await stored(stalled.id)).toMatchObject({
      status: EmailStatus.FAILED,
      error: 'SES outcome unknown: its job was lost; not retried to avoid a duplicate',
    });
    expect((await failedEvent(stalled.id))?.data).toMatchObject({
      reason: 'stalled_without_checkpoint',
      attempts: 1,
    });
  });

  it('runs again the finished job of a message SES accepted, which records it', async () => {
    const stalled = await email(EmailStatus.SENDING);
    await finish(stalled, 'completed', {acceptedBySes: {messageId: 'ses-accepted', sentAt: new Date().toISOString()}});

    expect(await sweepStalledEmails(10)).toEqual({requeued: 0, settled: 1});

    expect(await stateOf(stalled.id)).toBe('waiting');
    expect(await stored(stalled.id)).toMatchObject({status: EmailStatus.SENDING});
  });

  it('looks at the emails untouched the longest first', async () => {
    const oldest = await email(EmailStatus.PENDING, 40);
    const older = await email(EmailStatus.PENDING, 30);
    const newest = await email(EmailStatus.PENDING, 20);

    expect(await sweepStalledEmails(2)).toEqual({requeued: 2, settled: 0});

    expect(await emailQueue.getJob(`email-${oldest.id}`)).toBeDefined();
    expect(await emailQueue.getJob(`email-${older.id}`)).toBeDefined();
    expect(await emailQueue.getJob(`email-${newest.id}`)).toBeUndefined();
  });

  it('goes on after an email it cannot settle', async () => {
    const first = await email(EmailStatus.PENDING, 30);
    const second = await email(EmailStatus.PENDING, 20);
    vi.spyOn(emailQueue, 'getJob').mockRejectedValueOnce(new Error('redis unavailable'));

    expect(await sweepStalledEmails(10)).toEqual({requeued: 1, settled: 0});

    expect(await emailQueue.getJob(`email-${first.id}`)).toBeUndefined();
    expect(await emailQueue.getJob(`email-${second.id}`)).toBeDefined();
  });
});
