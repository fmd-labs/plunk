import {CampaignStatus, EmailStatus} from '@plunk/db';
import type {SendEmailJobData} from '@plunk/types';
import {toPrismaJson} from '@plunk/types';
import {type Job, UnrecoverableError} from 'bullmq';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {prisma as runtimePrisma} from '../../database/prisma.js';
import {CampaignService} from '../../services/CampaignService.js';
import {EventService} from '../../services/EventService.js';
import {SecurityService} from '../../services/SecurityService.js';
import {processEmailJob} from '../email-processor';

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
 * A stand-in for a BullMQ job. `processEmailJob` reads the job data and attempt counters and
 * checkpoints an SES acceptance with `updateData`; nothing else of the job is used.
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
  };
  return job;
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
    const email = await factories.createEmail(projectId, contactId, {
      status: EmailStatus.SENDING,
      campaignId: campaign.id,
    });

    await expect(processEmailJob(asJob(fakeJob(email.id)))).rejects.toBeInstanceOf(UnrecoverableError);

    expect(sesMocks.submitRawEmail).not.toHaveBeenCalled();
    expect(await stored(email.id)).toMatchObject({
      status: EmailStatus.FAILED,
      error: 'SES outcome unknown: an earlier attempt stopped while sending it; not retried to avoid a duplicate',
    });
    const {revertPending} = await CampaignService.cancel(projectId, campaign.id);
    expect(revertPending).toBe(false);
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

  it('does not send an email another run claimed first', async () => {
    const email = await factories.createEmail(projectId, contactId, {status: EmailStatus.PENDING});
    vi.spyOn(SecurityService, 'checkPhishingContent').mockImplementationOnce(async () => {
      // Another run of the same email claims it while this one runs its checks.
      await prisma.email.update({where: {id: email.id}, data: {status: EmailStatus.SENDING}});
      return {isPhishing: false, confidence: 0, shouldDisable: false};
    });

    await expect(processEmailJob(asJob(fakeJob(email.id)))).resolves.toBeUndefined();

    expect(sesMocks.submitRawEmail).not.toHaveBeenCalled();
    expect((await stored(email.id)).status).toBe(EmailStatus.SENDING);
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
