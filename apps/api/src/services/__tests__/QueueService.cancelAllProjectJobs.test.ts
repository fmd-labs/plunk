import {EmailSourceType, EmailStatus} from '@plunk/db';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {emailQueue, QueueService, removeProjectJobs, scheduledQueue} from '../QueueService';

afterEach(() => {
  vi.restoreAllMocks();
});

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

  it('keeps the retry of an email left SENDING, which records its outcome', async () => {
    const {project} = await factories.createUserWithProject();
    const contact = await factories.createContact({projectId: project.id});
    const sending = await factories.createEmail(project.id, contact.id, {status: EmailStatus.SENDING});
    await QueueService.queueEmail(sending.id, EmailSourceType.TRANSACTIONAL, 60_000);

    await QueueService.cancelAllProjectJobs(project.id);

    expect(await emailQueue.getJob(`email-${sending.id}`)).toBeDefined();
  });

  it('still fails the pending emails when clearing a queue fails', async () => {
    const {project} = await factories.createUserWithProject();
    const email = await pendingEmail(project.id);
    vi.spyOn(scheduledQueue, 'getJobs').mockRejectedValueOnce(new Error('redis unavailable'));

    await expect(QueueService.cancelAllProjectJobs(project.id)).rejects.toThrow('redis unavailable');

    expect(await prisma.email.findUniqueOrThrow({where: {id: email.id}})).toMatchObject({
      status: EmailStatus.FAILED,
      error: 'Project is disabled',
    });
  });
});

describe('removeProjectJobs', () => {
  beforeEach(async () => {
    await emailQueue.obliterate({force: true});
  });

  /** Queue a job per id, oldest first, prioritized as every email job is. */
  async function queue(ids: string[]) {
    for (const id of ids) {
      await emailQueue.add('send-email', {emailId: id}, {jobId: `email-${id}`, priority: 1});
    }
  }

  async function left() {
    return (await emailQueue.getJobs(['prioritized'])).map(job => job.data.emailId).sort();
  }

  const ours = async (keys: string[]) => keys.filter(key => key.startsWith('own'));

  it('removes every job of the project a page at a time, while a worker takes jobs', async () => {
    await queue(['own-1', 'own-2', 'own-3', 'other-1', 'own-4', 'other-2', 'own-5']);
    let pages = 0;

    const removed = await removeProjectJobs(
      emailQueue,
      job => job.data.emailId,
      async keys => {
        if (pages++ === 0) {
          // A worker takes the oldest job while the first page is looked at.
          const [oldest] = await emailQueue.getJobs(['prioritized'], 0, 0, true);
          await emailQueue.remove(oldest!.id!);
        }
        return ours(keys);
      },
      'email',
      2,
    );

    expect(removed).toBe(4);
    expect(await left()).toEqual(['other-1', 'other-2']);
  });

  it('reads past an entry whose job is gone', async () => {
    await queue(['own-1', 'own-2', 'own-3']);
    // Its id stays listed, but the job itself is gone.
    await (await emailQueue.client).del(emailQueue.toKey('email-own-2'));

    await removeProjectJobs(emailQueue, job => job.data.emailId, ours, 'email', 1);

    expect(await emailQueue.getJob('email-own-1')).toBeUndefined();
    expect(await emailQueue.getJob('email-own-3')).toBeUndefined();
  });

  it('carries on when a job cannot be removed', async () => {
    await queue(['own-1', 'own-2', 'own-3']);
    vi.spyOn(emailQueue, 'remove').mockRejectedValueOnce(new Error('locked'));

    const removed = await removeProjectJobs(emailQueue, job => job.data.emailId, ours, 'email', 2);

    expect(removed).toBe(2);
    expect(await left()).toHaveLength(1);
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
