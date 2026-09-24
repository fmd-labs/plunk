import {EmailSourceType, EmailStatus} from '@plunk/db';
import {beforeEach, describe, expect, it} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {emailQueue, QueueService} from '../QueueService';

describe('QueueService.cancelAllProjectJobs', () => {
  const prisma = getPrismaClient();

  beforeEach(async () => {
    await emailQueue.obliterate({force: true});
  });

  async function pendingEmail(projectId: string) {
    const contact = await factories.createContact({projectId});
    return factories.createEmail(projectId, contact.id, {status: EmailStatus.PENDING});
  }

  it('removes the queued email jobs of the project, prioritized ones included, and fails their emails', async () => {
    const {project} = await factories.createUserWithProject();
    const {project: other} = await factories.createUserWithProject();
    const transactional = await pendingEmail(project.id);
    const campaign = await pendingEmail(project.id);
    const delayed = await pendingEmail(project.id);
    const othersEmail = await pendingEmail(other.id);
    // Queued as the send paths queue them: every email job has a priority.
    await QueueService.queueEmail(transactional.id, EmailSourceType.TRANSACTIONAL);
    await QueueService.queueEmail(campaign.id, EmailSourceType.CAMPAIGN);
    await QueueService.queueEmail(delayed.id, EmailSourceType.WORKFLOW, 60_000);
    await QueueService.queueEmail(othersEmail.id, EmailSourceType.TRANSACTIONAL);
    expect(await emailQueue.getJobCounts('prioritized', 'delayed')).toEqual({prioritized: 3, delayed: 1});

    await QueueService.cancelAllProjectJobs(project.id);

    for (const email of [transactional, campaign, delayed]) {
      expect(await emailQueue.getJob(`email-${email.id}`)).toBeUndefined();
      expect(await prisma.email.findUniqueOrThrow({where: {id: email.id}})).toMatchObject({
        status: EmailStatus.FAILED,
        error: 'Project is disabled',
      });
    }
    expect(await emailQueue.getJob(`email-${othersEmail.id}`)).toBeDefined();
    expect((await prisma.email.findUniqueOrThrow({where: {id: othersEmail.id}})).status).toBe(EmailStatus.PENDING);
  });

  it('keeps a job that checkpointed an SES acceptance, which records the message as sent', async () => {
    const {project} = await factories.createUserWithProject();
    const contact = await factories.createContact({projectId: project.id});
    const accepted = await factories.createEmail(project.id, contact.id, {status: EmailStatus.SENDING});
    await emailQueue.add(
      'send-email',
      {emailId: accepted.id, acceptedBySes: {messageId: 'ses-accepted', sentAt: new Date().toISOString()}},
      {jobId: `email-${accepted.id}`, delay: 60_000},
    );

    await QueueService.cancelAllProjectJobs(project.id);

    expect(await emailQueue.getJob(`email-${accepted.id}`)).toBeDefined();
    expect((await prisma.email.findUniqueOrThrow({where: {id: accepted.id}})).status).toBe(EmailStatus.SENDING);
  });
});

describe('QueueService.getStats', () => {
  beforeEach(async () => {
    await emailQueue.obliterate({force: true});
  });

  it('counts prioritized email jobs', async () => {
    const {project} = await factories.createUserWithProject();
    const contact = await factories.createContact({projectId: project.id});
    const email = await factories.createEmail(project.id, contact.id, {status: EmailStatus.PENDING});
    await QueueService.queueEmail(email.id, EmailSourceType.TRANSACTIONAL);

    expect((await QueueService.getStats()).email).toMatchObject({prioritized: 1, waiting: 0});
  });
});
