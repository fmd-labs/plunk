import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {CampaignStatus, EmailStatus, TrackingMode} from '@plunk/db';
import {toPrismaJson} from '@plunk/types';
import {factories, getPrismaClient} from '../../../../../test/helpers';
import {prisma as runtimePrisma} from '../../database/prisma.js';
import {CampaignService} from '../../services/CampaignService.js';
import {emailQueue} from '../../services/QueueService.js';
import {createEmailWorker} from '../email-processor';

// The two places where the retry fix (FORK.md D04) meets code that upstream `next` added after it
// was written: the cancelled-campaign guard and the `simulated` stamp. The fix's own cases live in
// email-processor.test.ts.

const sesMocks = vi.hoisted(() => ({
  getSendingQuota: vi.fn(),
  sendRawEmail: vi.fn(),
}));

vi.mock('../../services/SESService.js', () => sesMocks);

vi.mock('../../services/MeterService.js', () => ({
  MeterService: {recordEmailSent: vi.fn().mockResolvedValue(undefined)},
}));

const SIMULATOR_ADDRESS = 'bounce@simulator.amazonses.com';

async function waitForEmailStatus(emailId: string, status: EmailStatus) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const email = await getPrismaClient().email.findUniqueOrThrow({where: {id: emailId}});
    if (email.status === status) return email;
    await new Promise(resolve => setTimeout(resolve, 25));
  }

  throw new Error(`Email ${emailId} did not reach ${status}`);
}

function enqueue(emailId: string, name: string) {
  return emailQueue.add(
    'send-email',
    {emailId},
    {jobId: `${name}-${emailId}`, attempts: 2, backoff: {type: 'fixed', delay: 10}},
  );
}

// Called from inside the SES mock, i.e. after the SENDING write, so only the writes that record
// the accepted message fail.
function failAcceptedWrites({fallbackToo}: {fallbackToo: boolean}) {
  vi.spyOn(runtimePrisma.email, 'updateMany').mockRejectedValueOnce(new Error('database unavailable'));
  if (fallbackToo) {
    vi.spyOn(runtimePrisma.email, 'update').mockRejectedValueOnce(new Error('database still unavailable'));
  }
}

describe('Email processor retries: cancelled campaigns and simulated sends', () => {
  const prisma = getPrismaClient();
  let projectId: string;

  beforeEach(async () => {
    // A job left over from an earlier test would be picked up by this test's worker.
    await emailQueue.obliterate({force: true});
    sesMocks.getSendingQuota.mockReset().mockResolvedValue({
      maxSendRate: 14,
      sentLast24Hours: 0,
      max24HourSend: 200,
    });
    sesMocks.sendRawEmail.mockReset().mockResolvedValue({messageId: 'mock-message-id'});
    const {project} = await factories.createUserWithProject({}, {tracking: TrackingMode.ENABLED});
    projectId = project.id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('records a checkpointed acceptance as SENT after its campaign was cancelled', async () => {
    const campaign = await factories.createCampaign({projectId, status: CampaignStatus.SENDING});
    const contact = await factories.createContact({projectId});
    const email = await factories.createEmail(projectId, contact.id, {
      campaignId: campaign.id,
      status: EmailStatus.PENDING,
    });
    sesMocks.sendRawEmail.mockImplementationOnce(async () => {
      // Cancelled while SES accepts the message; both SENT writes then fail, so only the job's
      // checkpoint knows the message left.
      await prisma.campaign.update({where: {id: campaign.id}, data: {status: CampaignStatus.CANCELLED}});
      failAcceptedWrites({fallbackToo: true});
      return {messageId: 'ses-cancelled-campaign'};
    });
    const worker = await createEmailWorker();

    try {
      await enqueue(email.id, 'cancelled-checkpoint');
      await expect(waitForEmailStatus(email.id, EmailStatus.SENT)).resolves.toMatchObject({
        messageId: 'ses-cancelled-campaign',
        error: null,
      });
    } finally {
      await worker.close();
    }

    expect(sesMocks.sendRawEmail).toHaveBeenCalledOnce();

    // The SENT row is what keeps the cancel terminal: FAILED without sentAt would read as never
    // sent, and a repeated cancel would queue the revert to DRAFT.
    const {campaign: cancelled, revertPending} = await CampaignService.cancel(projectId, campaign.id);
    expect(cancelled.status).toBe(CampaignStatus.CANCELLED);
    expect(revertPending).toBe(false);
  });

  it('does not resend a retried email once its campaign was cancelled', async () => {
    const campaign = await factories.createCampaign({projectId, status: CampaignStatus.SENDING});
    const contact = await factories.createContact({projectId});
    const email = await factories.createEmail(projectId, contact.id, {
      campaignId: campaign.id,
      status: EmailStatus.PENDING,
    });
    sesMocks.sendRawEmail.mockImplementationOnce(async () => {
      await prisma.campaign.update({where: {id: campaign.id}, data: {status: CampaignStatus.CANCELLED}});
      throw Object.assign(new Error('transient SES failure'), {$metadata: {httpStatusCode: 503}});
    });
    const worker = await createEmailWorker();

    try {
      await enqueue(email.id, 'cancelled-retry');
      await expect(waitForEmailStatus(email.id, EmailStatus.FAILED)).resolves.toMatchObject({
        error: 'Campaign cancelled',
        sentAt: null,
      });
    } finally {
      await worker.close();
    }

    expect(sesMocks.sendRawEmail).toHaveBeenCalledOnce();
  });

  it('stamps simulated on the fallback SENT write, from the recipient override', async () => {
    const contact = await factories.createContact({projectId});
    const email = await factories.createEmail(projectId, contact.id, {status: EmailStatus.PENDING});
    await prisma.email.update({
      where: {id: email.id},
      data: {headers: toPrismaJson({'X-Plunk-Recipient-Override': SIMULATOR_ADDRESS})},
    });
    sesMocks.sendRawEmail.mockImplementationOnce(async () => {
      failAcceptedWrites({fallbackToo: false});
      return {messageId: 'ses-simulated-fallback'};
    });
    const worker = await createEmailWorker();

    try {
      await enqueue(email.id, 'simulated-fallback');
      // The error text shows the catch's fallback write recorded it, not the SENT update.
      await expect(waitForEmailStatus(email.id, EmailStatus.SENT)).resolves.toMatchObject({
        messageId: 'ses-simulated-fallback',
        simulated: true,
        error: 'Post-send processing failed: database unavailable',
      });
    } finally {
      await worker.close();
    }

    expect(sesMocks.sendRawEmail).toHaveBeenCalledOnce();
    expect(sesMocks.sendRawEmail).toHaveBeenCalledWith(expect.objectContaining({to: [SIMULATOR_ADDRESS]}));
  });

  it('stamps simulated when a checkpointed retry records the acceptance', async () => {
    const contact = await factories.createContact({projectId, email: SIMULATOR_ADDRESS});
    const email = await factories.createEmail(projectId, contact.id, {status: EmailStatus.PENDING});
    sesMocks.sendRawEmail.mockImplementationOnce(async () => {
      failAcceptedWrites({fallbackToo: true});
      return {messageId: 'ses-simulated-retry'};
    });
    const worker = await createEmailWorker();

    try {
      await enqueue(email.id, 'simulated-retry');
      await expect(waitForEmailStatus(email.id, EmailStatus.SENT)).resolves.toMatchObject({
        messageId: 'ses-simulated-retry',
        simulated: true,
      });
    } finally {
      await worker.close();
    }

    expect(sesMocks.sendRawEmail).toHaveBeenCalledOnce();
  });
});
