import {randomUUID} from 'node:crypto';

import {CampaignStatus, type Email, EmailSourceType, EmailStatus} from '@plunk/db';
import {toPrismaJson} from '@plunk/types';
import {Worker} from 'bullmq';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {prisma as runtimePrisma} from '../../database/prisma.js';
import {redis} from '../../database/redis.js';
import {Keys} from '../../services/keys.js';
import {emailQueue, QueueService} from '../../services/QueueService.js';
import {processSweep, sweepStalledEmails} from '../email-stall-sweep-processor';

describe('sweepStalledEmails', () => {
  const prisma = getPrismaClient();
  let projectId: string;
  let contactId: string;

  beforeEach(async () => {
    await emailQueue.obliterate({force: true});
    await redis.del(Keys.Email.stallSweepCursor('direct'), Keys.Email.stallSweepCursor('campaign'));
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
    contactId = (await factories.createContact({projectId})).id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** An email last touched `minutes` ago, created `hours` ago (the time it was touched by default). */
  async function email(
    status: EmailStatus,
    minutes = 16,
    headers?: Record<string, string>,
    {hours, campaignId}: {hours?: number; campaignId?: string} = {},
  ) {
    const created = await factories.createEmail(projectId, contactId, {status, campaignId});
    return prisma.email.update({
      where: {id: created.id},
      data: {
        updatedAt: new Date(Date.now() - minutes * 60_000),
        createdAt: new Date(Date.now() - (hours === undefined ? minutes * 60_000 : hours * 3_600_000)),
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

  function sweep(
    limits: {settle?: number; ms?: number; pageSize?: number; batchSize?: number; maxAgeMs?: number} = {},
  ) {
    return sweepStalledEmails({settle: 10, ms: 10_000, ...limits});
  }

  function cursor(pass: 'direct' | 'campaign' = 'direct') {
    return redis.get(Keys.Email.stallSweepCursor(pass));
  }

  async function stateOf(emailId: string) {
    return (await emailQueue.getJob(`email-${emailId}`))?.getState();
  }

  it('queues again an email left PENDING without a job, with the priority it was sent with', async () => {
    const stalled = await email(EmailStatus.PENDING, 16, {'X-Plunk-Priority': 'low'});

    expect(await sweep()).toEqual({requeued: 1, settled: 0, closed: 0});

    const job = await emailQueue.getJob(`email-${stalled.id}`);
    expect(job?.data).toEqual({emailId: stalled.id});
    expect(job?.opts.priority).toBe(10);
  });

  it('leaves an email whose job is still waiting, or waiting to be retried', async () => {
    const waiting = await email(EmailStatus.PENDING);
    const delayed = await email(EmailStatus.SENDING);
    await QueueService.queueEmail(waiting.id, EmailSourceType.TRANSACTIONAL);
    await QueueService.queueEmail(delayed.id, EmailSourceType.TRANSACTIONAL, 60_000);

    expect(await sweep()).toEqual({requeued: 0, settled: 0, closed: 0});

    expect(await stored(delayed.id)).toMatchObject({status: EmailStatus.SENDING});
    expect(await stateOf(delayed.id)).toBe('delayed');
  });

  it('leaves an email whose job waits without a priority, or runs', async () => {
    const waiting = await email(EmailStatus.PENDING);
    const active = await email(EmailStatus.SENDING);
    await emailQueue.add('send-email', {emailId: active.id}, {jobId: `email-${active.id}`, priority: 1});
    const worker = new Worker(emailQueue.name, null, {connection: emailQueue.opts.connection, autorun: false});

    try {
      // A worker takes the job of the SENDING email, and holds its lock.
      const taken = await worker.getNextJob('test-token', {block: false});
      expect(taken?.data.emailId).toBe(active.id);
      await emailQueue.add('send-email', {emailId: waiting.id}, {jobId: `email-${waiting.id}`});

      expect(await sweep()).toEqual({requeued: 0, settled: 0, closed: 0});

      expect(await stateOf(waiting.id)).toBe('waiting');
      expect(await stateOf(active.id)).toBe('active');
      expect(await stored(active.id)).toMatchObject({status: EmailStatus.SENDING});
    } finally {
      await worker.close();
    }
  });

  it('looks past the emails whose jobs still wait', async () => {
    for (const minutes of [50, 40, 30]) {
      const waiting = await email(EmailStatus.PENDING, minutes);
      await QueueService.queueEmail(waiting.id, EmailSourceType.TRANSACTIONAL);
    }
    const lost = await email(EmailStatus.PENDING, 20);

    expect(await sweep({pageSize: 2})).toEqual({requeued: 1, settled: 0, closed: 0});

    expect(await stateOf(lost.id)).toBe('prioritized');
  });

  it('leaves an email touched in the last 15 minutes', async () => {
    const recent = await email(EmailStatus.PENDING, 14);

    expect(await sweep()).toEqual({requeued: 0, settled: 0, closed: 0});

    expect(await emailQueue.getJob(`email-${recent.id}`)).toBeUndefined();
  });

  it("fails an email whose job failed for good, with the job's error", async () => {
    const stalled = await email(EmailStatus.PENDING);
    await finish(stalled, 'failed');

    expect(await sweep()).toEqual({requeued: 0, settled: 1, closed: 0});

    expect(await stored(stalled.id)).toMatchObject({status: EmailStatus.FAILED, error: 'SES unavailable'});
    expect((await failedEvent(stalled.id))?.data).toMatchObject({reason: 'attempts_exhausted', attempts: 1});
  });

  it('runs again the failed job of a message SES accepted, which records it', async () => {
    const stalled = await email(EmailStatus.SENDING);
    await finish(stalled, 'failed', {acceptedBySes: {messageId: 'ses-accepted', sentAt: new Date().toISOString()}});

    expect(await sweep()).toEqual({requeued: 1, settled: 0, closed: 0});

    expect(await stateOf(stalled.id)).toBe('waiting');
    expect(await stored(stalled.id)).toMatchObject({status: EmailStatus.SENDING});
    expect(await failedEvent(stalled.id)).toBeNull();
  });

  it('does not count an email whose failed job it could not settle', async () => {
    const stalled = await email(EmailStatus.PENDING);
    await finish(stalled, 'failed');
    vi.spyOn(runtimePrisma.email, 'findUnique').mockRejectedValueOnce(new Error('database unavailable'));

    expect(await sweep()).toEqual({requeued: 0, settled: 0, closed: 0});

    expect(await stored(stalled.id)).toMatchObject({status: EmailStatus.PENDING});
  });

  it('does not count an email another run settled first', async () => {
    const lost = await email(EmailStatus.SENDING);
    const failed = await email(EmailStatus.PENDING);
    await finish(failed, 'failed');
    // Each write finds its email no longer PENDING or SENDING.
    vi.spyOn(runtimePrisma.email, 'updateMany').mockResolvedValue({count: 0});

    expect(await sweep()).toEqual({requeued: 0, settled: 0, closed: 0});

    expect(await failedEvent(lost.id)).toBeNull();
    expect(await failedEvent(failed.id)).toBeNull();
  });

  it('queues again a PENDING email whose job completed without settling it', async () => {
    const stalled = await email(EmailStatus.PENDING);
    await finish(stalled, 'completed');

    expect(await sweep()).toEqual({requeued: 1, settled: 0, closed: 0});

    expect(await stateOf(stalled.id)).toBe('prioritized');
  });

  it('fails an email left SENDING without a job as an unknown outcome', async () => {
    const stalled = await email(EmailStatus.SENDING);

    expect(await sweep()).toEqual({requeued: 0, settled: 1, closed: 0});

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

    expect(await sweep()).toEqual({requeued: 1, settled: 0, closed: 0});

    const job = await emailQueue.getJob(`email-${stalled.id}`);
    expect(await job?.getState()).toBe('waiting');
    expect(job?.data).toMatchObject({acceptedBySes: {messageId: 'ses-accepted'}});
    // The same job, run again: the run it finished still counts.
    expect(job?.attemptsMade).toBe(1);
    expect(await stored(stalled.id)).toMatchObject({status: EmailStatus.SENDING});
  });

  it('runs again a job left in no queue list that holds an SES acceptance', async () => {
    const stalled = await email(EmailStatus.SENDING);
    await finish(stalled, 'completed', {acceptedBySes: {messageId: 'ses-accepted', sentAt: new Date().toISOString()}});
    await (await emailQueue.client).zrem(emailQueue.toKey('completed'), `email-${stalled.id}`);
    expect(await stateOf(stalled.id)).toBe('unknown');

    expect(await sweep()).toEqual({requeued: 1, settled: 0, closed: 0});

    const job = await emailQueue.getJob(`email-${stalled.id}`);
    expect(await job?.getState()).toBe('waiting');
    expect(job?.data).toMatchObject({acceptedBySes: {messageId: 'ses-accepted'}});
  });

  it('settles the emails untouched the longest first, up to its limit, and goes on there next run', async () => {
    const oldest = await email(EmailStatus.SENDING, 40);
    const older = await email(EmailStatus.SENDING, 30);
    const newest = await email(EmailStatus.SENDING, 20);

    expect(await sweep({settle: 2})).toEqual({requeued: 0, settled: 2, closed: 0});

    expect((await stored(oldest.id)).status).toBe(EmailStatus.FAILED);
    expect((await stored(older.id)).status).toBe(EmailStatus.FAILED);
    expect((await stored(newest.id)).status).toBe(EmailStatus.SENDING);
    expect(JSON.parse((await cursor())!)).toEqual({
      updatedAt: older.updatedAt.toISOString(),
      id: older.id,
    });

    expect(await sweep({settle: 2})).toEqual({requeued: 0, settled: 1, closed: 0});
    expect((await stored(newest.id)).status).toBe(EmailStatus.FAILED);
  });

  it('does not count queueing an email again towards its limit', async () => {
    for (const minutes of [40, 30, 20]) {
      await email(EmailStatus.PENDING, minutes);
    }

    expect(await sweep({settle: 1})).toEqual({requeued: 3, settled: 0, closed: 0});
  });

  it('goes on after the email the last run stopped at, and starts over once it reaches the end', async () => {
    const first = await email(EmailStatus.SENDING, 40);
    const second = await email(EmailStatus.SENDING, 30);
    await redis.set(Keys.Email.stallSweepCursor('direct'), JSON.stringify({updatedAt: first.updatedAt, id: first.id}));

    expect(await sweep()).toEqual({requeued: 0, settled: 1, closed: 0});

    expect((await stored(first.id)).status).toBe(EmailStatus.SENDING);
    expect((await stored(second.id)).status).toBe(EmailStatus.FAILED);
    expect(await cursor()).toBeNull();

    expect(await sweep()).toEqual({requeued: 0, settled: 1, closed: 0});
    expect((await stored(first.id)).status).toBe(EmailStatus.FAILED);
  });

  it.each(['yesterday', '{"updatedAt":"yesterday","id":"x"}', '{"updatedAt":"2000-01-01T00:00:00.000Z","id":5}'])(
    'starts over when the place the last run stopped at cannot be read: %s',
    async place => {
      const stalled = await email(EmailStatus.SENDING);
      await redis.set(Keys.Email.stallSweepCursor('direct'), place);

      expect(await sweep()).toEqual({requeued: 0, settled: 1, closed: 0});

      expect((await stored(stalled.id)).status).toBe(EmailStatus.FAILED);
      expect(await cursor()).toBeNull();
    },
  );

  it('asks for the job states of a long page a batch at a time', async () => {
    // More emails whose jobs still wait than one batch of lookups covers, then one without a job.
    const touchedAt = new Date(Date.now() - 30 * 60_000);
    const waiting = Array.from({length: 501}, () => randomUUID());
    await prisma.email.createMany({
      data: waiting.map(id => ({
        id,
        projectId,
        contactId,
        subject: 'Test Email',
        body: '<p>Test email body</p>',
        from: 'test@example.com',
        sourceType: EmailSourceType.TRANSACTIONAL,
        updatedAt: touchedAt,
      })),
    });
    await emailQueue.addBulk(
      waiting.map(id => ({name: 'send-email', data: {emailId: id}, opts: {jobId: `email-${id}`, priority: 1}})),
    );
    const lost = await email(EmailStatus.PENDING, 20);

    expect(await sweep()).toEqual({requeued: 1, settled: 0, closed: 0});

    expect(await stateOf(lost.id)).toBe('prioritized');
  });

  it('reads each email once across pages, also emails touched at the same time', async () => {
    const touchedAt = new Date(Date.now() - 30 * 60_000);
    for (let i = 0; i < 5; i++) {
      const stalled = await email(EmailStatus.PENDING);
      await prisma.email.update({where: {id: stalled.id}, data: {updatedAt: touchedAt}});
    }

    expect(await sweep({pageSize: 2})).toEqual({requeued: 5, settled: 0, closed: 0});
  });

  it('works through the first batch of each page it reads, however long reading it took', async () => {
    const first = await email(EmailStatus.SENDING, 40);
    const second = await email(EmailStatus.SENDING, 30);

    expect(await sweep({ms: 0, batchSize: 1})).toEqual({requeued: 0, settled: 1, closed: 0});

    expect((await stored(first.id)).status).toBe(EmailStatus.FAILED);
    expect((await stored(second.id)).status).toBe(EmailStatus.SENDING);
    expect(JSON.parse((await cursor())!)).toEqual({updatedAt: first.updatedAt.toISOString(), id: first.id});
  });

  it.each([
    ['within a page', {batchSize: 1}],
    ['between pages', {pageSize: 1}],
  ])('stops %s once its time is up, and goes on there next run', async (_where, size) => {
    const first = await email(EmailStatus.SENDING, 40);
    const second = await email(EmailStatus.SENDING, 30);
    const getJob = emailQueue.getJob.bind(emailQueue);
    // Settling the first email outlasts the run's time.
    vi.spyOn(emailQueue, 'getJob').mockImplementationOnce(async jobId => {
      await new Promise(resolve => setTimeout(resolve, 1100));
      return getJob(jobId);
    });

    expect(await sweep({ms: 2000, ...size})).toEqual({requeued: 0, settled: 1, closed: 0});

    expect((await stored(first.id)).status).toBe(EmailStatus.FAILED);
    expect((await stored(second.id)).status).toBe(EmailStatus.SENDING);
    expect(JSON.parse((await cursor())!)).toEqual({
      updatedAt: first.updatedAt.toISOString(),
      id: first.id,
    });

    expect(await sweep()).toEqual({requeued: 0, settled: 1, closed: 0});
    expect((await stored(second.id)).status).toBe(EmailStatus.FAILED);
  });

  it('fails an email too old to send, without sending or reporting it', async () => {
    const stalled = await email(EmailStatus.PENDING, 16, undefined, {hours: 25});

    expect(await sweep()).toEqual({requeued: 0, settled: 0, closed: 1});

    expect(await stored(stalled.id)).toMatchObject({
      status: EmailStatus.FAILED,
      error: 'Not sent: left without a job to send it, found more than 24 hours after it was created',
    });
    expect(await emailQueue.getJob(`email-${stalled.id}`)).toBeUndefined();
    expect(await failedEvent(stalled.id)).toBeNull();
  });

  it('fails an email left SENDING too long ago as an unknown outcome, without reporting it', async () => {
    const stalled = await email(EmailStatus.SENDING, 16, undefined, {hours: 25});

    expect(await sweep()).toEqual({requeued: 0, settled: 0, closed: 1});

    expect(await stored(stalled.id)).toMatchObject({
      status: EmailStatus.FAILED,
      error:
        'SES outcome unknown: its job was lost, found more than 24 hours after it was created; not retried to avoid a duplicate',
    });
    expect(await failedEvent(stalled.id)).toBeNull();
  });

  it('fails an old email whose job failed for good without reporting it', async () => {
    const stalled = await email(EmailStatus.PENDING, 16, undefined, {hours: 25});
    await finish(stalled, 'failed');

    expect(await sweep()).toEqual({requeued: 0, settled: 0, closed: 1});

    expect((await stored(stalled.id)).status).toBe(EmailStatus.FAILED);
    expect(await failedEvent(stalled.id)).toBeNull();
  });

  it('records a message SES accepted however old its email is', async () => {
    const stalled = await email(EmailStatus.SENDING, 16, undefined, {hours: 25});
    await finish(stalled, 'completed', {acceptedBySes: {messageId: 'ses-accepted', sentAt: new Date().toISOString()}});

    expect(await sweep()).toEqual({requeued: 1, settled: 0, closed: 0});

    expect(await stateOf(stalled.id)).toBe('waiting');
  });

  it('takes the age past which it sends nothing from its limits', async () => {
    const young = await email(EmailStatus.PENDING, 16, undefined, {hours: 0.5});
    const old = await email(EmailStatus.PENDING, 16, undefined, {hours: 2});

    expect(await sweep({maxAgeMs: 3_600_000})).toEqual({requeued: 1, settled: 0, closed: 1});

    expect(await stateOf(young.id)).toBe('prioritized');
    expect(await stored(old.id)).toMatchObject({
      status: EmailStatus.FAILED,
      error: 'Not sent: left without a job to send it, found more than 1 hour after it was created',
    });
  });

  it('fails an email of a disabled project without queueing or reporting it', async () => {
    const stalled = await email(EmailStatus.PENDING);
    await prisma.project.update({where: {id: projectId}, data: {disabled: true}});

    expect(await sweep()).toEqual({requeued: 0, settled: 0, closed: 1});

    expect(await stored(stalled.id)).toMatchObject({status: EmailStatus.FAILED, error: 'Project is disabled'});
    expect(await emailQueue.getJob(`email-${stalled.id}`)).toBeUndefined();
    expect(await failedEvent(stalled.id)).toBeNull();
  });

  it('settles the emails of no campaign before campaign emails', async () => {
    const campaign = await factories.createCampaign({projectId, status: CampaignStatus.SENDING});
    const campaignEmails = await Promise.all(
      [60, 50, 40].map(minutes => email(EmailStatus.SENDING, minutes, undefined, {campaignId: campaign.id})),
    );
    const transactional = await email(EmailStatus.SENDING, 20);

    expect(await sweep({settle: 1})).toEqual({requeued: 0, settled: 1, closed: 0});

    expect((await stored(transactional.id)).status).toBe(EmailStatus.FAILED);
    for (const campaignEmail of campaignEmails) {
      expect((await stored(campaignEmail.id)).status).toBe(EmailStatus.SENDING);
    }

    expect(await sweep({settle: 10})).toEqual({requeued: 0, settled: 3, closed: 0});
  });

  it('leaves the campaign emails their share of a run however long the others take', async () => {
    const campaign = await factories.createCampaign({projectId, status: CampaignStatus.SENDING});
    const first = await email(EmailStatus.SENDING, 40);
    const second = await email(EmailStatus.SENDING, 30);
    const campaignEmail = await email(EmailStatus.SENDING, 20, undefined, {campaignId: campaign.id});
    const getJob = emailQueue.getJob.bind(emailQueue);
    // Settling the first email outlasts the half of the run's time the emails of no campaign get.
    vi.spyOn(emailQueue, 'getJob').mockImplementationOnce(async jobId => {
      await new Promise(resolve => setTimeout(resolve, 1100));
      return getJob(jobId);
    });

    expect(await sweep({ms: 2000, batchSize: 1})).toEqual({requeued: 0, settled: 2, closed: 0});

    expect((await stored(first.id)).status).toBe(EmailStatus.FAILED);
    expect((await stored(second.id)).status).toBe(EmailStatus.SENDING);
    expect((await stored(campaignEmail.id)).status).toBe(EmailStatus.FAILED);
    expect(JSON.parse((await cursor('direct'))!)).toMatchObject({id: first.id});
    expect(await cursor('campaign')).toBeNull();
  });

  it('does nothing while switched off', async () => {
    const stalled = await email(EmailStatus.SENDING);

    expect(await processSweep(false)).toEqual({requeued: 0, settled: 0, closed: 0});

    expect((await stored(stalled.id)).status).toBe(EmailStatus.SENDING);
  });

  it('goes on after an email it cannot settle', async () => {
    const first = await email(EmailStatus.PENDING, 30);
    const second = await email(EmailStatus.PENDING, 20);
    vi.spyOn(emailQueue, 'getJob').mockRejectedValueOnce(new Error('redis unavailable'));

    expect(await sweep()).toEqual({requeued: 1, settled: 0, closed: 0});

    expect(await emailQueue.getJob(`email-${first.id}`)).toBeUndefined();
    expect(await emailQueue.getJob(`email-${second.id}`)).toBeDefined();
  });
});
