import {CampaignStatus, EmailStatus} from '@plunk/db';
import type {SendEmailJobData} from '@plunk/types';
import {toPrismaJson} from '@plunk/types';
import {DelayedError, type Job, UnrecoverableError} from 'bullmq';
import {simpleParser} from 'mailparser';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {prisma as runtimePrisma} from '../../database/prisma.js';
import {CampaignService} from '../../services/CampaignService.js';
import {EventService} from '../../services/EventService.js';
import {QueueService} from '../../services/QueueService.js';
import {SecurityService} from '../../services/SecurityService.js';
import {processEmailJob, settleFailedJob} from '../email-processor';

const sesMocks = vi.hoisted(() => ({
  getSendingQuota: vi.fn(),
  submitRawEmail: vi.fn(),
}));

// Messages are built for real; only the submission to SES is faked.
vi.mock('../../services/SESService.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../services/SESService.js')>()),
  ...sesMocks,
}));

vi.mock('../../services/MeterService.js', () => ({
  MeterService: {
    recordEmailSent: vi.fn().mockResolvedValue(undefined),
  },
}));

/**
 * A stand-in for a BullMQ job. `processEmailJob` reads the job data and attempt counters,
 * checkpoints an SES acceptance with `updateData` and waits for a later run with `moveToDelayed`;
 * `settleFailedJob` runs a failed job again with `retry`. Nothing else of the job is used.
 */
function fakeJob(emailId: string, {attemptsMade = 0, attempts = 3} = {}) {
  const job = {
    id: `email-${emailId}`,
    data: {emailId} as SendEmailJobData,
    attemptsMade,
    opts: {attempts},
    updateData: vi.fn(async (data: SendEmailJobData) => {
      job.data = data;
    }),
    moveToDelayed: vi.fn(async (_timestamp: number, _token?: string) => undefined),
    retry: vi.fn(async (_state?: string) => undefined),
  };
  return job;
}

/** The email, as claimed (made SENDING) `minutes` ago. */
function claimedMinutesAgo(email: {id: string}, minutes: number) {
  return getPrismaClient().email.update({
    where: {id: email.id},
    data: {updatedAt: new Date(Date.now() - minutes * 60_000)},
  });
}

/** How long after `since` the job was set to run again. */
function delayOf(job: ReturnType<typeof fakeJob>, since: number) {
  const [[timestamp]] = job.moveToDelayed.mock.calls as [[number, string?]];
  return timestamp - since;
}

function asJob(job: ReturnType<typeof fakeJob>) {
  return job as unknown as Job<SendEmailJobData>;
}

describe('processEmailJob', () => {
  const prisma = getPrismaClient();
  let projectId: string;
  let contactId: string;

  beforeEach(async () => {
    sesMocks.getSendingQuota.mockReset();
    sesMocks.submitRawEmail.mockReset().mockResolvedValue({messageId: 'ses-message-id'});
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
    contactId = (await factories.createContact({projectId})).id;
  });

  it('sends a pending email and records it as sent', async () => {
    const email = await factories.createEmail(projectId, contactId, {status: EmailStatus.PENDING});
    const job = fakeJob(email.id);

    await processEmailJob(asJob(job));

    expect(sesMocks.submitRawEmail).toHaveBeenCalledTimes(1);
    const stored = await prisma.email.findUniqueOrThrow({where: {id: email.id}});
    expect(stored.status).toBe(EmailStatus.SENT);
    expect(stored.messageId).toBe('ses-message-id');
    expect(stored.sentAt).not.toBeNull();
    expect(job.data.acceptedBySes?.messageId).toBe('ses-message-id');
  });

  it('does nothing when the email no longer exists', async () => {
    await expect(processEmailJob(asJob(fakeJob('00000000-0000-4000-8000-000000000000')))).resolves.toBeUndefined();
    expect(sesMocks.submitRawEmail).not.toHaveBeenCalled();
  });

  it('does not send an email that is no longer pending', async () => {
    const email = await factories.createEmail(projectId, contactId, {
      status: EmailStatus.SENT,
      sentAt: new Date(),
      messageId: 'earlier-message-id',
    });

    await processEmailJob(asJob(fakeJob(email.id)));

    expect(sesMocks.submitRawEmail).not.toHaveBeenCalled();
    const stored = await prisma.email.findUniqueOrThrow({where: {id: email.id}});
    expect(stored.messageId).toBe('earlier-message-id');
  });

  it('fails the email without calling SES when the project is disabled', async () => {
    const {project} = await factories.createUserWithProject({}, {disabled: true});
    const contact = await factories.createContact({projectId: project.id});
    const email = await factories.createEmail(project.id, contact.id, {status: EmailStatus.PENDING});

    await processEmailJob(asJob(fakeJob(email.id)));

    expect(sesMocks.submitRawEmail).not.toHaveBeenCalled();
    const stored = await prisma.email.findUniqueOrThrow({where: {id: email.id}});
    expect(stored.status).toBe(EmailStatus.FAILED);
    expect(stored.error).toBe('Project is disabled');
  });

  /** The message the job handed to SES, as a mail client reads it. */
  async function submittedMessage() {
    const [message] = sesMocks.submitRawEmail.mock.calls[0] as [{mime: string}];
    return simpleParser(message.mime);
  }

  it('sends an email with templating off as it was written', async () => {
    const email = await factories.createEmail(projectId, contactId, {
      status: EmailStatus.PENDING,
      subject: 'Hi {{name}}',
      body: '<p>{{name}} {% if vip %}VIP{% endif %}</p>',
    });
    await prisma.email.update({
      where: {id: email.id},
      data: {headers: toPrismaJson({'X-Plunk-Templating': 'off'})},
    });

    await processEmailJob(asJob(fakeJob(email.id)));

    const message = await submittedMessage();
    expect(message.subject).toBe('Hi {{name}}');
    expect(message.html).toContain('<p>{{name}} {% if vip %}VIP{% endif %}</p>');
  });

  it('never sends a header of its own, whatever its letter case', async () => {
    const email = await factories.createEmail(projectId, contactId, {status: EmailStatus.PENDING});
    await prisma.email.update({
      where: {id: email.id},
      data: {headers: toPrismaJson({'X-Plunk-Templating': 'off', 'x-plunk-future': 'internal', 'X-Custom': 'kept'})},
    });

    await processEmailJob(asJob(fakeJob(email.id)));

    const message = await submittedMessage();
    expect(message.headers.get('x-custom')).toBe('kept');
    expect([...message.headers.keys()].filter(name => name.startsWith('x-plunk-'))).toEqual([]);
  });
});

// Failures as the AWS SDK raises them: an SES answer, and a transport error without one.
function sesAnswer(name: string, httpStatusCode: number) {
  return Object.assign(new Error(`${name} from SES`), {name, $metadata: {httpStatusCode}});
}

function transportError(code: string, name = 'Error') {
  return Object.assign(new Error(`${code} while sending`), {code, name});
}

describe('processEmailJob outcomes', () => {
  const prisma = getPrismaClient();
  let projectId: string;
  let contactId: string;

  beforeEach(async () => {
    sesMocks.submitRawEmail.mockReset().mockResolvedValue({messageId: 'ses-message-id'});
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
    contactId = (await factories.createContact({projectId})).id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function stored(emailId: string) {
    return prisma.email.findUniqueOrThrow({where: {id: emailId}});
  }

  /** A SENDING campaign with a second email still pending, so failing one does not finish it. */
  async function sendingCampaign() {
    const campaign = await factories.createCampaign({projectId, status: CampaignStatus.SENDING});
    await factories.createEmail(projectId, contactId, {status: EmailStatus.PENDING, campaignId: campaign.id});
    return campaign;
  }

  it('keeps the email PENDING for another attempt when SES throttles', async () => {
    const email = await factories.createEmail(projectId, contactId, {status: EmailStatus.PENDING});
    const throttled = sesAnswer('Throttling', 400);
    sesMocks.submitRawEmail.mockRejectedValueOnce(throttled);

    await expect(processEmailJob(asJob(fakeJob(email.id)))).rejects.toBe(throttled);

    expect(await stored(email.id)).toMatchObject({status: EmailStatus.PENDING, error: throttled.message, sentAt: null});
  });

  it('keeps the email PENDING when the connection to SES was never made', async () => {
    const email = await factories.createEmail(projectId, contactId, {status: EmailStatus.PENDING});
    sesMocks.submitRawEmail.mockRejectedValueOnce(transportError('ECONNREFUSED'));

    await expect(processEmailJob(asJob(fakeJob(email.id)))).rejects.toThrow('ECONNREFUSED');

    expect((await stored(email.id)).status).toBe(EmailStatus.PENDING);
  });

  it('fails the email once its attempts are exhausted', async () => {
    const email = await factories.createEmail(projectId, contactId, {status: EmailStatus.PENDING});
    const unavailable = sesAnswer('ServiceUnavailable', 503);
    sesMocks.submitRawEmail.mockRejectedValueOnce(unavailable);

    await expect(processEmailJob(asJob(fakeJob(email.id, {attemptsMade: 2, attempts: 3})))).rejects.toBe(unavailable);

    expect(await stored(email.id)).toMatchObject({status: EmailStatus.FAILED, error: unavailable.message});
  });

  it('fails an email SES rejects, without another attempt', async () => {
    const email = await factories.createEmail(projectId, contactId, {status: EmailStatus.PENDING});
    sesMocks.submitRawEmail.mockRejectedValueOnce(sesAnswer('MessageRejected', 400));

    await expect(processEmailJob(asJob(fakeJob(email.id)))).rejects.toBeInstanceOf(UnrecoverableError);

    expect(await stored(email.id)).toMatchObject({status: EmailStatus.FAILED, error: 'MessageRejected from SES'});
  });

  it('records an unknown outcome, which keeps a cancelled campaign from reverting to draft', async () => {
    const campaign = await sendingCampaign();
    const email = await factories.createEmail(projectId, contactId, {
      status: EmailStatus.PENDING,
      campaignId: campaign.id,
    });
    // What the SDK raises when the connection drops after the request went out.
    sesMocks.submitRawEmail.mockRejectedValueOnce(transportError('ECONNRESET', 'TimeoutError'));

    await expect(processEmailJob(asJob(fakeJob(email.id)))).rejects.toBeInstanceOf(UnrecoverableError);

    expect(await stored(email.id)).toMatchObject({
      status: EmailStatus.FAILED,
      error: 'SES outcome unknown: ECONNRESET while sending; not retried to avoid a duplicate',
    });
    // SES may have accepted it, so cancelling keeps the campaign CANCELLED rather than reverting it
    // to a draft whose next send would reach this recipient again.
    const {campaign: cancelled, revertPending} = await CampaignService.cancel(projectId, campaign.id);
    expect(cancelled.status).toBe(CampaignStatus.CANCELLED);
    expect(revertPending).toBe(false);
  });

  it('fails an email an earlier attempt left SENDING as an unknown outcome', async () => {
    const campaign = await sendingCampaign();
    const email = await claimedMinutesAgo(
      await factories.createEmail(projectId, contactId, {status: EmailStatus.SENDING, campaignId: campaign.id}),
      3,
    );

    await expect(processEmailJob(asJob(fakeJob(email.id)))).rejects.toBeInstanceOf(UnrecoverableError);

    expect(sesMocks.submitRawEmail).not.toHaveBeenCalled();
    expect(await stored(email.id)).toMatchObject({
      status: EmailStatus.FAILED,
      error: 'SES outcome unknown: an earlier attempt stopped while sending it; not retried to avoid a duplicate',
    });
    const {revertPending} = await CampaignService.cancel(projectId, campaign.id);
    expect(revertPending).toBe(false);
  });

  it('waits for a run that claimed the email moments ago before failing it', async () => {
    const email = await claimedMinutesAgo(
      await factories.createEmail(projectId, contactId, {status: EmailStatus.SENDING}),
      0.5,
    );
    const job = fakeJob(email.id);
    const before = Date.now();

    await expect(processEmailJob(asJob(job), 'worker-token')).rejects.toBeInstanceOf(DelayedError);

    // Until two minutes after the claim, then it looks again.
    expect(delayOf(job, before)).toBeGreaterThan(85_000);
    expect(delayOf(job, before)).toBeLessThanOrEqual(90_000);
    expect(await stored(email.id)).toMatchObject({status: EmailStatus.SENDING, error: null});
  });

  it('keeps the email PENDING when building the message fails', async () => {
    const email = await factories.createEmail(projectId, contactId, {status: EmailStatus.PENDING});
    // An attachment without content cannot be encoded.
    await prisma.email.update({
      where: {id: email.id},
      data: {attachments: toPrismaJson([{filename: 'broken.txt', contentType: 'text/plain'}])},
    });
    const updates = vi.spyOn(runtimePrisma.email, 'updateMany');

    await expect(processEmailJob(asJob(fakeJob(email.id)))).rejects.toThrow();

    expect(sesMocks.submitRawEmail).not.toHaveBeenCalled();
    expect((await stored(email.id)).status).toBe(EmailStatus.PENDING);
    // The message is built before the email is claimed, so it was never marked SENDING.
    expect(updates.mock.calls.some(([args]) => args.data.status === EmailStatus.SENDING)).toBe(false);
  });

  it('does not send an email another run claimed first, and looks at it again once that run is over', async () => {
    const email = await factories.createEmail(projectId, contactId, {status: EmailStatus.PENDING});
    vi.spyOn(SecurityService, 'checkPhishingContent').mockImplementationOnce(async () => {
      // Another run of the same email claims it while this one runs its checks.
      await prisma.email.update({where: {id: email.id}, data: {status: EmailStatus.SENDING}});
      return {isPhishing: false, confidence: 0, shouldDisable: false};
    });
    const job = fakeJob(email.id);
    const before = Date.now();

    await expect(processEmailJob(asJob(job), 'worker-token')).rejects.toBeInstanceOf(DelayedError);

    expect(sesMocks.submitRawEmail).not.toHaveBeenCalled();
    expect((await stored(email.id)).status).toBe(EmailStatus.SENDING);
    expect(job.moveToDelayed).toHaveBeenCalledWith(expect.any(Number), 'worker-token');
    expect(delayOf(job, before)).toBeGreaterThanOrEqual(120_000);
    expect(delayOf(job, before)).toBeLessThan(125_000);
  });

  it('leaves the email as it is when its claim fails while it still reads as pending', async () => {
    const email = await factories.createEmail(projectId, contactId, {status: EmailStatus.PENDING});
    // The claim loses a race that the email, read again, no longer shows.
    vi.spyOn(runtimePrisma.email, 'updateMany').mockResolvedValueOnce({count: 0});
    const job = fakeJob(email.id, {attemptsMade: 2, attempts: 3});

    await expect(processEmailJob(asJob(job), 'worker-token')).rejects.toBeInstanceOf(DelayedError);

    expect(sesMocks.submitRawEmail).not.toHaveBeenCalled();
    expect(await stored(email.id)).toMatchObject({status: EmailStatus.PENDING, error: null});
  });

  it('leaves the email alone when the job cannot be moved to wait for another run', async () => {
    const email = await factories.createEmail(projectId, contactId, {status: EmailStatus.PENDING});
    vi.spyOn(runtimePrisma.email, 'updateMany').mockResolvedValueOnce({count: 0});
    const job = fakeJob(email.id, {attemptsMade: 2, attempts: 3});
    const lockLost = new Error('Missing lock for job');
    job.moveToDelayed.mockRejectedValueOnce(lockLost);

    await expect(processEmailJob(asJob(job), 'worker-token')).rejects.toBe(lockLost);

    // Not a failure to send: the email is neither failed nor given the error.
    expect(await stored(email.id)).toMatchObject({status: EmailStatus.PENDING, error: null});
  });

  it('ends the job when another run sent the email first', async () => {
    const email = await factories.createEmail(projectId, contactId, {status: EmailStatus.PENDING});
    vi.spyOn(SecurityService, 'checkPhishingContent').mockImplementationOnce(async () => {
      await prisma.email.update({
        where: {id: email.id},
        data: {status: EmailStatus.SENT, sentAt: new Date(), messageId: 'ses-other-run'},
      });
      return {isPhishing: false, confidence: 0, shouldDisable: false};
    });
    const job = fakeJob(email.id);

    await expect(processEmailJob(asJob(job), 'worker-token')).resolves.toBeUndefined();

    expect(sesMocks.submitRawEmail).not.toHaveBeenCalled();
    expect(job.moveToDelayed).not.toHaveBeenCalled();
  });

  it('waits to record a message SES accepted while the database fails, without spending an attempt', async () => {
    const email = await factories.createEmail(projectId, contactId, {status: EmailStatus.PENDING});
    sesMocks.submitRawEmail.mockImplementationOnce(async () => {
      // The claim succeeded; both writes of the acceptance fail.
      vi.spyOn(runtimePrisma.email, 'updateMany')
        .mockRejectedValueOnce(new Error('database unavailable'))
        .mockRejectedValueOnce(new Error('database still unavailable'));
      return {messageId: 'ses-accepted'};
    });
    const job = fakeJob(email.id, {attemptsMade: 2, attempts: 3});
    const before = Date.now();

    await expect(processEmailJob(asJob(job), 'worker-token')).rejects.toBeInstanceOf(DelayedError);

    expect(job.data.acceptedBySes?.messageId).toBe('ses-accepted');
    expect(job.moveToDelayed).toHaveBeenCalledWith(expect.any(Number), 'worker-token');
    // Right after the acceptance, the first wait is a second.
    expect(delayOf(job, before)).toBeGreaterThanOrEqual(1_000);
    expect(delayOf(job, before)).toBeLessThan(5_000);
    expect((await stored(email.id)).status).toBe(EmailStatus.SENDING);
  });

  it('waits for the database when a later run cannot load the email it is to record', async () => {
    const email = await factories.createEmail(projectId, contactId, {status: EmailStatus.SENDING});
    const job = fakeJob(email.id);
    job.data = {
      emailId: email.id,
      acceptedBySes: {messageId: 'ses-earlier', sentAt: new Date(Date.now() - 10 * 60_000).toISOString()},
    };
    vi.spyOn(runtimePrisma.email, 'findUnique').mockRejectedValueOnce(new Error('database unavailable'));
    const before = Date.now();

    await expect(processEmailJob(asJob(job), 'worker-token')).rejects.toBeInstanceOf(DelayedError);

    // Ten minutes after the acceptance, the wait has reached its 2-minute cap.
    expect(delayOf(job, before)).toBeGreaterThanOrEqual(120_000);
    expect(delayOf(job, before)).toBeLessThan(125_000);
    expect((await stored(email.id)).status).toBe(EmailStatus.SENDING);
  });

  it('spends an attempt when it cannot load an email it has not sent', async () => {
    const email = await factories.createEmail(projectId, contactId, {status: EmailStatus.PENDING});
    const job = fakeJob(email.id);
    vi.spyOn(runtimePrisma.email, 'findUnique').mockRejectedValueOnce(new Error('database unavailable'));

    await expect(processEmailJob(asJob(job), 'worker-token')).rejects.toThrow('database unavailable');

    expect(job.moveToDelayed).not.toHaveBeenCalled();
  });

  it('does not send a campaign email whose campaign is cancelled while it is prepared', async () => {
    const campaign = await factories.createCampaign({projectId, status: CampaignStatus.SENDING});
    const email = await factories.createEmail(projectId, contactId, {
      status: EmailStatus.PENDING,
      campaignId: campaign.id,
    });
    vi.spyOn(SecurityService, 'checkPhishingContent').mockImplementationOnce(async () => {
      await CampaignService.cancel(projectId, campaign.id);
      return {isPhishing: false, confidence: 0, shouldDisable: false};
    });

    await expect(processEmailJob(asJob(fakeJob(email.id)))).resolves.toBeUndefined();

    expect(sesMocks.submitRawEmail).not.toHaveBeenCalled();
    expect(await stored(email.id)).toMatchObject({status: EmailStatus.FAILED, error: 'Campaign cancelled'});
  });

  it.each([
    {case: 'with attempts left', attemptsMade: 0},
    {case: 'on its last attempt', attemptsMade: 2},
  ])("leaves another run's claim alone when it fails before claiming, $case", async ({attemptsMade}) => {
    const email = await factories.createEmail(projectId, contactId, {status: EmailStatus.PENDING});
    vi.spyOn(SecurityService, 'checkPhishingContent').mockImplementationOnce(async () => {
      // Another run of the same email claims it, then this run fails before its own claim.
      await prisma.email.update({where: {id: email.id}, data: {status: EmailStatus.SENDING}});
      throw new Error('connection pool timeout');
    });

    await expect(processEmailJob(asJob(fakeJob(email.id, {attemptsMade, attempts: 3})))).rejects.toThrow(
      'connection pool timeout',
    );

    expect(sesMocks.submitRawEmail).not.toHaveBeenCalled();
    expect(await stored(email.id)).toMatchObject({status: EmailStatus.SENDING, error: null});
  });

  it('lets the campaign finish when its last email fails', async () => {
    const campaign = await factories.createCampaign({projectId, status: CampaignStatus.SENDING});
    const email = await factories.createEmail(projectId, contactId, {
      status: EmailStatus.PENDING,
      campaignId: campaign.id,
    });
    sesMocks.submitRawEmail.mockRejectedValueOnce(sesAnswer('MessageRejected', 400));

    await expect(processEmailJob(asJob(fakeJob(email.id)))).rejects.toBeInstanceOf(UnrecoverableError);

    expect((await prisma.campaign.findUniqueOrThrow({where: {id: campaign.id}})).status).toBe(CampaignStatus.SENT);
  });

  it('does not repeat the steps after the send when a retried write finds it recorded', async () => {
    const campaign = await factories.createCampaign({projectId, status: CampaignStatus.SENDING});
    const email = await factories.createEmail(projectId, contactId, {
      status: EmailStatus.PENDING,
      campaignId: campaign.id,
    });
    const trackEvent = vi.spyOn(EventService, 'trackEvent');
    sesMocks.submitRawEmail.mockImplementationOnce(async () => {
      // Another run records the email while this run's first write fails.
      await prisma.email.update({
        where: {id: email.id},
        data: {status: EmailStatus.SENT, sentAt: new Date(), messageId: 'ses-other-run'},
      });
      vi.spyOn(runtimePrisma.email, 'updateMany').mockRejectedValueOnce(new Error('database unavailable'));
      return {messageId: 'ses-message-id'};
    });

    await expect(processEmailJob(asJob(fakeJob(email.id)))).resolves.toBeUndefined();

    expect(trackEvent).not.toHaveBeenCalled();
    expect((await stored(email.id)).messageId).toBe('ses-other-run');
    // The email is terminal either way, so its campaign still finishes.
    expect((await prisma.campaign.findUniqueOrThrow({where: {id: campaign.id}})).status).toBe(CampaignStatus.SENT);
  });

  it('marks the email failed before disabling its project for phishing', async () => {
    const email = await factories.createEmail(projectId, contactId, {status: EmailStatus.PENDING});
    vi.spyOn(SecurityService, 'checkPhishingContent').mockResolvedValueOnce({
      isPhishing: true,
      confidence: 0.99,
      shouldDisable: true,
    });
    const statusWhenDisabling: EmailStatus[] = [];
    vi.spyOn(SecurityService, 'disableProjectForPhishing').mockImplementationOnce(async () => {
      statusWhenDisabling.push((await stored(email.id)).status);
    });

    await expect(processEmailJob(asJob(fakeJob(email.id)))).rejects.toBeInstanceOf(UnrecoverableError);

    expect(statusWhenDisabling).toEqual([EmailStatus.FAILED]);
    expect(sesMocks.submitRawEmail).not.toHaveBeenCalled();
  });

  it('disables the project and ends the job for phishing even when recording the failure fails', async () => {
    const email = await factories.createEmail(projectId, contactId, {status: EmailStatus.PENDING});
    vi.spyOn(SecurityService, 'checkPhishingContent').mockResolvedValueOnce({
      isPhishing: true,
      confidence: 0.99,
      shouldDisable: true,
    });
    const disable = vi.spyOn(SecurityService, 'disableProjectForPhishing').mockResolvedValueOnce();
    vi.spyOn(runtimePrisma.email, 'updateMany').mockRejectedValueOnce(new Error('database unavailable'));

    // Not retried: the sampled check would most likely not flag the email again.
    await expect(processEmailJob(asJob(fakeJob(email.id)))).rejects.toBeInstanceOf(UnrecoverableError);

    expect(disable).toHaveBeenCalledOnce();
    expect(sesMocks.submitRawEmail).not.toHaveBeenCalled();
    // Not recorded by this run, so not reported by it either.
    expect(await prisma.event.count({where: {emailId: email.id, name: 'email.failed'}})).toBe(0);
  });

  it('looks again at an email another run holds, also when its campaign has stopped', async () => {
    const campaign = await factories.createCampaign({projectId, status: CampaignStatus.SENDING});
    const email = await factories.createEmail(projectId, contactId, {
      status: EmailStatus.PENDING,
      campaignId: campaign.id,
    });
    vi.spyOn(SecurityService, 'checkPhishingContent').mockImplementationOnce(async () => {
      // Another run claims the email, then the campaign is cancelled, while this one runs its checks.
      await prisma.email.update({where: {id: email.id}, data: {status: EmailStatus.SENDING}});
      await prisma.campaign.update({where: {id: campaign.id}, data: {status: CampaignStatus.CANCELLED}});
      return {isPhishing: false, confidence: 0, shouldDisable: false};
    });
    const job = fakeJob(email.id);

    // The job stays, to record the outcome should the other run fail to.
    await expect(processEmailJob(asJob(job), 'worker-token')).rejects.toBeInstanceOf(DelayedError);

    expect(job.moveToDelayed).toHaveBeenCalledOnce();
    expect(sesMocks.submitRawEmail).not.toHaveBeenCalled();
    expect(await stored(email.id)).toMatchObject({status: EmailStatus.SENDING, error: null});
  });

  it('completes and runs the later steps when a step after the send fails', async () => {
    const campaign = await factories.createCampaign({projectId, status: CampaignStatus.SENDING});
    const email = await factories.createEmail(projectId, contactId, {
      status: EmailStatus.PENDING,
      campaignId: campaign.id,
    });
    vi.spyOn(EventService, 'trackEvent').mockRejectedValueOnce(new Error('event store unavailable'));

    await expect(processEmailJob(asJob(fakeJob(email.id)))).resolves.toBeUndefined();

    expect(await stored(email.id)).toMatchObject({status: EmailStatus.SENT, messageId: 'ses-message-id', error: null});
    // Finalizing the campaign comes after the event, and still ran.
    expect((await prisma.campaign.findUniqueOrThrow({where: {id: campaign.id}})).status).toBe(CampaignStatus.SENT);
  });

  it('reports when SES accepted it when a retry records an earlier acceptance', async () => {
    const email = await factories.createEmail(projectId, contactId, {status: EmailStatus.SENDING});
    const trackEvent = vi.spyOn(EventService, 'trackEvent');
    const job = fakeJob(email.id);
    job.data = {emailId: email.id, acceptedBySes: {messageId: 'ses-earlier', sentAt: '2026-01-02T03:04:05.000Z'}};

    await processEmailJob(asJob(job));

    expect(sesMocks.submitRawEmail).not.toHaveBeenCalled();
    expect(await stored(email.id)).toMatchObject({
      status: EmailStatus.SENT,
      messageId: 'ses-earlier',
      sentAt: new Date('2026-01-02T03:04:05.000Z'),
    });
    expect(trackEvent).toHaveBeenCalledWith(
      projectId,
      'email.sent',
      contactId,
      email.id,
      expect.objectContaining({sentAt: '2026-01-02T03:04:05.000Z'}),
    );
  });
});

describe('settleFailedJob', () => {
  const prisma = getPrismaClient();
  let projectId: string;
  let contactId: string;

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
    contactId = (await factories.createContact({projectId})).id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function stored(emailId: string) {
    return prisma.email.findUniqueOrThrow({where: {id: emailId}});
  }

  const stalled = new Error('job stalled more than allowable limit');

  function failedEvent(emailId: string) {
    return prisma.event.findFirst({where: {emailId, name: 'email.failed'}});
  }

  it('fails an email its job left PENDING, and lets its campaign finish', async () => {
    const campaign = await factories.createCampaign({projectId, status: CampaignStatus.SENDING});
    const email = await factories.createEmail(projectId, contactId, {
      status: EmailStatus.PENDING,
      campaignId: campaign.id,
    });

    await settleFailedJob(asJob(fakeJob(email.id, {attemptsMade: 3})), stalled);

    expect(await stored(email.id)).toMatchObject({status: EmailStatus.FAILED, error: stalled.message});
    expect((await failedEvent(email.id))?.data).toMatchObject({reason: 'attempts_exhausted', attempts: 3});
    expect((await prisma.campaign.findUniqueOrThrow({where: {id: campaign.id}})).status).toBe(CampaignStatus.SENT);
  });

  it('records an email its job left SENDING as an unknown outcome', async () => {
    const email = await factories.createEmail(projectId, contactId, {status: EmailStatus.SENDING});

    await settleFailedJob(asJob(fakeJob(email.id, {attemptsMade: 2})), stalled);

    expect(await stored(email.id)).toMatchObject({
      status: EmailStatus.FAILED,
      error: 'SES outcome unknown: job stalled more than allowable limit; not retried to avoid a duplicate',
    });
    expect((await failedEvent(email.id))?.data).toMatchObject({reason: 'stalled_without_checkpoint', attempts: 2});
  });

  it('runs the job of a message SES accepted again, to record it', async () => {
    const email = await factories.createEmail(projectId, contactId, {status: EmailStatus.SENDING});
    const job = fakeJob(email.id);
    job.data = {emailId: email.id, acceptedBySes: {messageId: 'ses-accepted', sentAt: new Date().toISOString()}};

    await settleFailedJob(asJob(job), stalled);

    expect(job.retry).toHaveBeenCalledWith('failed');
    expect((await stored(email.id)).status).toBe(EmailStatus.SENDING);
  });

  it('leaves an email its job already settled alone', async () => {
    const email = await factories.createEmail(projectId, contactId, {
      status: EmailStatus.FAILED,
      error: 'MessageRejected from SES',
    });
    const job = fakeJob(email.id);

    await settleFailedJob(asJob(job), stalled);

    expect(await stored(email.id)).toMatchObject({status: EmailStatus.FAILED, error: 'MessageRejected from SES'});
    expect(job.retry).not.toHaveBeenCalled();
  });

  it('never rejects', async () => {
    vi.spyOn(runtimePrisma.email, 'findUnique').mockRejectedValueOnce(new Error('database unavailable'));

    await expect(
      settleFailedJob(asJob(fakeJob('00000000-0000-4000-8000-000000000000')), stalled),
    ).resolves.toBeUndefined();
  });
});

describe('email.failed', () => {
  const prisma = getPrismaClient();
  let projectId: string;
  let contactId: string;

  beforeEach(async () => {
    sesMocks.submitRawEmail.mockReset().mockResolvedValue({messageId: 'ses-message-id'});
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
    contactId = (await factories.createContact({projectId})).id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function failedEvents(emailId: string) {
    return prisma.event.findMany({where: {emailId, name: 'email.failed'}});
  }

  it('reports an email SES rejects, with what failed and why', async () => {
    const email = await factories.createEmail(projectId, contactId, {status: EmailStatus.PENDING});
    sesMocks.submitRawEmail.mockRejectedValueOnce(sesAnswer('MessageRejected', 400));

    await expect(processEmailJob(asJob(fakeJob(email.id, {attemptsMade: 1})))).rejects.toBeInstanceOf(
      UnrecoverableError,
    );

    const events = await failedEvents(email.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({projectId, contactId});
    expect(events[0]?.data).toEqual({
      subject: email.subject,
      from: email.from,
      fromName: email.fromName,
      messageId: null,
      emailId: email.id,
      templateId: null,
      campaignId: null,
      sourceType: email.sourceType,
      error: 'MessageRejected from SES',
      reason: 'ses_rejected',
      attempts: 2,
      failedAt: expect.any(String),
    });
  });

  it('reports an email whose attempts are exhausted', async () => {
    const email = await factories.createEmail(projectId, contactId, {status: EmailStatus.PENDING});
    sesMocks.submitRawEmail.mockRejectedValueOnce(sesAnswer('ServiceUnavailable', 503));

    await expect(processEmailJob(asJob(fakeJob(email.id, {attemptsMade: 2, attempts: 3})))).rejects.toThrow();

    expect((await failedEvents(email.id))[0]?.data).toMatchObject({reason: 'attempts_exhausted', attempts: 3});
  });

  it('reports an email whose outcome at SES is unknown', async () => {
    const email = await factories.createEmail(projectId, contactId, {status: EmailStatus.PENDING});
    sesMocks.submitRawEmail.mockRejectedValueOnce(transportError('ECONNRESET', 'TimeoutError'));

    await expect(processEmailJob(asJob(fakeJob(email.id)))).rejects.toBeInstanceOf(UnrecoverableError);

    expect((await failedEvents(email.id))[0]?.data).toMatchObject({
      reason: 'ses_outcome_unknown',
      error: 'SES outcome unknown: ECONNRESET while sending; not retried to avoid a duplicate',
    });
  });

  it('reports an email an earlier attempt left SENDING', async () => {
    const email = await claimedMinutesAgo(
      await factories.createEmail(projectId, contactId, {status: EmailStatus.SENDING}),
      3,
    );

    await expect(processEmailJob(asJob(fakeJob(email.id, {attemptsMade: 1})))).rejects.toBeInstanceOf(
      UnrecoverableError,
    );

    expect((await failedEvents(email.id))[0]?.data).toMatchObject({reason: 'stalled_without_checkpoint', attempts: 2});
  });

  it('reports the template and the campaign of an email', async () => {
    const template = await factories.createTemplate({projectId});
    const campaign = await factories.createCampaign({projectId, status: CampaignStatus.SENDING});
    const email = await factories.createEmail(projectId, contactId, {
      status: EmailStatus.PENDING,
      templateId: template.id,
      campaignId: campaign.id,
    });
    sesMocks.submitRawEmail.mockRejectedValueOnce(sesAnswer('MessageRejected', 400));

    await expect(processEmailJob(asJob(fakeJob(email.id)))).rejects.toBeInstanceOf(UnrecoverableError);

    expect((await failedEvents(email.id))[0]?.data).toMatchObject({templateId: template.id, campaignId: campaign.id});
  });

  it('fails the email as it would without the report when reporting it fails', async () => {
    const email = await factories.createEmail(projectId, contactId, {status: EmailStatus.PENDING});
    sesMocks.submitRawEmail.mockRejectedValueOnce(sesAnswer('MessageRejected', 400));
    vi.spyOn(EventService, 'trackEvent').mockRejectedValueOnce(new Error('event store unavailable'));

    await expect(processEmailJob(asJob(fakeJob(email.id)))).rejects.toBeInstanceOf(UnrecoverableError);

    expect(await stored(email.id)).toMatchObject({status: EmailStatus.FAILED, error: 'MessageRejected from SES'});
  });

  it('reports an email of a disabled project', async () => {
    const {project} = await factories.createUserWithProject({}, {disabled: true});
    const contact = await factories.createContact({projectId: project.id});
    const email = await factories.createEmail(project.id, contact.id, {status: EmailStatus.PENDING});

    await processEmailJob(asJob(fakeJob(email.id)));

    expect((await failedEvents(email.id))[0]?.data).toMatchObject({reason: 'project_disabled'});
  });

  it('reports an email blocked for phishing', async () => {
    const email = await factories.createEmail(projectId, contactId, {status: EmailStatus.PENDING});
    vi.spyOn(SecurityService, 'checkPhishingContent').mockResolvedValueOnce({
      isPhishing: true,
      confidence: 0.99,
      shouldDisable: true,
    });
    const order: string[] = [];
    vi.spyOn(SecurityService, 'disableProjectForPhishing').mockImplementationOnce(async () => {
      order.push('disabled');
    });
    const trackEvent = EventService.trackEvent.bind(EventService);
    vi.spyOn(EventService, 'trackEvent').mockImplementation(async (...args) => {
      order.push(args[1]);
      return trackEvent(...args);
    });

    await expect(processEmailJob(asJob(fakeJob(email.id)))).rejects.toBeInstanceOf(UnrecoverableError);

    expect((await failedEvents(email.id))[0]?.data).toMatchObject({reason: 'phishing_blocked'});
    // Reported once the project is disabled, so that none of its workflows run first.
    expect(order).toEqual(['disabled', 'email.failed']);
  });

  it('does not report an email it will try again', async () => {
    const email = await factories.createEmail(projectId, contactId, {status: EmailStatus.PENDING});
    sesMocks.submitRawEmail.mockRejectedValueOnce(sesAnswer('Throttling', 400));

    await expect(processEmailJob(asJob(fakeJob(email.id)))).rejects.toThrow();

    expect(await failedEvents(email.id)).toEqual([]);
  });

  it('does not report an email another run recorded first', async () => {
    const email = await factories.createEmail(projectId, contactId, {status: EmailStatus.PENDING});
    sesMocks.submitRawEmail.mockImplementationOnce(async () => {
      await prisma.email.update({where: {id: email.id}, data: {status: EmailStatus.FAILED, error: 'other run'}});
      throw sesAnswer('MessageRejected', 400);
    });

    await expect(processEmailJob(asJob(fakeJob(email.id)))).rejects.toBeInstanceOf(UnrecoverableError);

    expect(await failedEvents(email.id)).toEqual([]);
  });

  it('does not report the emails of a stopped campaign or a cancelled project', async () => {
    const campaign = await factories.createCampaign({projectId, status: CampaignStatus.CANCELLED});
    const cancelled = await factories.createEmail(projectId, contactId, {
      status: EmailStatus.PENDING,
      campaignId: campaign.id,
    });
    const pending = await factories.createEmail(projectId, contactId, {status: EmailStatus.PENDING});

    await processEmailJob(asJob(fakeJob(cancelled.id)));
    await QueueService.cancelAllProjectJobs(projectId);

    expect(await stored(cancelled.id)).toMatchObject({status: EmailStatus.FAILED, error: 'Campaign cancelled'});
    expect(await stored(pending.id)).toMatchObject({status: EmailStatus.FAILED, error: 'Project is disabled'});
    expect(await prisma.event.count({where: {projectId, name: 'email.failed'}})).toBe(0);
  });

  function stored(emailId: string) {
    return prisma.email.findUniqueOrThrow({where: {id: emailId}});
  }
});
