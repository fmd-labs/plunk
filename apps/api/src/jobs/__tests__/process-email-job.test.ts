import {EmailStatus} from '@plunk/db';
import type {SendEmailJobData} from '@plunk/types';
import type {Job} from 'bullmq';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {processEmailJob} from '../email-processor';

const sesMocks = vi.hoisted(() => ({
  getSendingQuota: vi.fn(),
  sendRawEmail: vi.fn(),
}));

vi.mock('../../services/SESService.js', () => sesMocks);

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
    sesMocks.sendRawEmail.mockReset().mockResolvedValue({messageId: 'ses-message-id'});
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
    contactId = (await factories.createContact({projectId})).id;
  });

  it('sends a pending email and records it as sent', async () => {
    const email = await factories.createEmail(projectId, contactId, {status: EmailStatus.PENDING});
    const job = fakeJob(email.id);

    await processEmailJob(asJob(job));

    expect(sesMocks.sendRawEmail).toHaveBeenCalledTimes(1);
    const stored = await prisma.email.findUniqueOrThrow({where: {id: email.id}});
    expect(stored.status).toBe(EmailStatus.SENT);
    expect(stored.messageId).toBe('ses-message-id');
    expect(stored.sentAt).not.toBeNull();
    expect(job.data.acceptedBySes?.messageId).toBe('ses-message-id');
  });

  it('does nothing when the email no longer exists', async () => {
    await expect(processEmailJob(asJob(fakeJob('00000000-0000-4000-8000-000000000000')))).resolves.toBeUndefined();
    expect(sesMocks.sendRawEmail).not.toHaveBeenCalled();
  });

  it('does not send an email that is no longer pending', async () => {
    const email = await factories.createEmail(projectId, contactId, {
      status: EmailStatus.SENT,
      sentAt: new Date(),
      messageId: 'earlier-message-id',
    });

    await processEmailJob(asJob(fakeJob(email.id)));

    expect(sesMocks.sendRawEmail).not.toHaveBeenCalled();
    const stored = await prisma.email.findUniqueOrThrow({where: {id: email.id}});
    expect(stored.messageId).toBe('earlier-message-id');
  });

  it('fails the email without calling SES when the project is disabled', async () => {
    const {project} = await factories.createUserWithProject({}, {disabled: true});
    const contact = await factories.createContact({projectId: project.id});
    const email = await factories.createEmail(project.id, contact.id, {status: EmailStatus.PENDING});

    await processEmailJob(asJob(fakeJob(email.id)));

    expect(sesMocks.sendRawEmail).not.toHaveBeenCalled();
    const stored = await prisma.email.findUniqueOrThrow({where: {id: email.id}});
    expect(stored.status).toBe(EmailStatus.FAILED);
    expect(stored.error).toBe('Project is disabled');
  });
});
