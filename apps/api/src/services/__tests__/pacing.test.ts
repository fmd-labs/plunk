import {CampaignStatus, EmailSourceType, EmailStatus, TopicBasis} from '@plunk/db';
import {pacedBatchSize, pacedDelayMs, pacedDurationMs} from '@plunk/shared';
import type {CampaignBatchJobData} from '@plunk/types';
import {randomUUID} from 'node:crypto';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {CAMPAIGN_EMAIL_PRIORITY} from '../../app/constants';
import {CampaignService} from '../CampaignService';
import {campaignQueue, emailQueue, QueueService} from '../QueueService';
import {TopicService} from '../TopicService';

/** Campaign pacing and the campaign email priority (D36). */
describe('campaign pacing', () => {
  const prisma = getPrismaClient();
  let projectId: string;

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Contacts whose ids sort in the order they are made, as the chain pages them; `from` continues a run. */
  async function contacts(count: number, from?: {prefix: string; index: number}) {
    const prefix = from?.prefix ?? randomUUID();
    const made = [];
    for (let i = from?.index ?? 0; made.length < count; i++) {
      made.push(
        await prisma.contact.create({
          data: {id: `${prefix}-${String(i).padStart(3, '0')}`, projectId, email: `c${i}-${prefix}@example.com`},
        }),
      );
    }
    return made;
  }

  async function sendingCampaign(sendsPerHour: number | null, data: {topicId?: string} = {}) {
    const created = await factories.createCampaign({projectId, status: CampaignStatus.SENDING});
    return prisma.campaign.update({
      where: {id: created.id},
      data: {sendsPerHour, sentAt: new Date(), ...data},
    });
  }

  /**
   * Runs a campaign's batch chain as the campaign worker would, the next batch at once rather than after its
   * delay; `between` runs before each batch after the first.
   */
  async function runChain(first: CampaignBatchJobData, between?: (batchNumber: number) => Promise<void>) {
    const next = vi.spyOn(QueueService, 'queueCampaignBatch').mockResolvedValue(undefined as never);
    let job: CampaignBatchJobData | undefined = first;
    while (job) {
      next.mockClear();
      await CampaignService.processBatch(job.campaignId, job.batchNumber, job.offset, job.limit, job.cursor, job);
      job = next.mock.calls[0]?.[0];
      if (job && between) {
        await between(job.batchNumber);
      }
    }
    next.mockRestore();
  }

  const reachedIds = async (campaignId: string) =>
    (await prisma.email.findMany({where: {campaignId}, select: {contactId: true}})).map(e => e.contactId).sort();

  const markSent = (campaignId: string) =>
    prisma.email.updateMany({where: {campaignId}, data: {status: EmailStatus.SENT, sentAt: new Date()}});

  const firstBatch = (campaignId: string, sendToken?: number): CampaignBatchJobData => ({
    campaignId,
    batchNumber: 1,
    offset: 0,
    limit: 500,
    sendToken,
  });

  it('splits an hour into twelve batches, and waits for each batch’s share of it', () => {
    expect(pacedBatchSize(null, 500)).toBe(500);
    expect(pacedBatchSize(1200, 500)).toBe(100);
    expect(pacedBatchSize(100_000, 500)).toBe(500);
    expect(pacedBatchSize(5, 500)).toBe(1);

    expect(pacedDelayMs(null, 500)).toBeUndefined();
    expect(pacedDelayMs(1200, 100)).toBe(5 * 60 * 1000);
    expect(pacedDelayMs(1200, 0)).toBeUndefined();

    // Every batch but the last waits: 250 at 1,200 per hour is batches of 100, 100 and 50.
    expect(pacedDurationMs(1200, 250)).toBe(10 * 60 * 1000);
    expect(pacedDurationMs(1200, 100)).toBe(0);
    expect(pacedDurationMs(null, 250)).toBe(0);
  });

  it('sends a paced campaign a batch at a time, queueing the next one after the batch’s share of the hour', async () => {
    await contacts(5);
    const campaign = await sendingCampaign(24);
    const next = vi.spyOn(QueueService, 'queueCampaignBatch').mockResolvedValue(undefined as never);

    await CampaignService.processBatch(campaign.id, 1, 0, 500);

    expect(await prisma.email.count({where: {campaignId: campaign.id}})).toBe(2);
    expect(next).toHaveBeenCalledTimes(1);
    const [data, delay] = next.mock.calls[0]!;
    expect(data).toMatchObject({campaignId: campaign.id, batchNumber: 2, limit: 500, reached: 2});
    expect(delay).toBe(5 * 60 * 1000);
  });

  it('sends an unpaced campaign in full batches, without a delay', async () => {
    await contacts(3);
    const campaign = await sendingCampaign(null);

    await CampaignService.processBatch(campaign.id, 1, 0, 2);

    expect(await prisma.email.count({where: {campaignId: campaign.id}})).toBe(2);
  });

  it('reaches every subscriber of an opt-in topic, one recipient per batch', async () => {
    await prisma.project.update({where: {id: projectId}, data: {topicsEnabled: true}});
    const topic = (await TopicService.upsert(projectId, 'news', {name: 'News', basis: TopicBasis.OPT_IN})).topic;
    const subscribers = await contacts(5);
    for (const contact of subscribers) {
      await TopicService.setContactStates(projectId, contact.id, {news: true});
    }
    const campaign = await sendingCampaign(12, {topicId: topic.id});

    await runChain(firstBatch(campaign.id));

    expect(await reachedIds(campaign.id)).toEqual(subscribers.map(c => c.id));
  });

  it('pages on when the last contact paged leaves the audience or is deleted between batches', async () => {
    const [c0, c1, c2, c3, c4, c5] = await contacts(6);
    const campaign = await sendingCampaign(24);

    await runChain(firstBatch(campaign.id), async batchNumber => {
      if (batchNumber === 2) {
        await prisma.contact.update({where: {id: c1!.id}, data: {subscribed: false}});
      }
      if (batchNumber === 3) {
        await prisma.contact.delete({where: {id: c3!.id}});
      }
    });

    // The deleted contact's email went with it.
    expect(await reachedIds(campaign.id)).toEqual([c0!.id, c1!.id, c2!.id, c4!.id, c5!.id]);
  });

  it('stays sending while batches remain, though the audience grew past the count it started with', async () => {
    const [c0] = await contacts(4);
    const created = await factories.createCampaign({projectId});
    await prisma.campaign.update({where: {id: created.id}, data: {sendsPerHour: 24}});
    const first = vi.spyOn(QueueService, 'queueCampaignBatch').mockResolvedValue(undefined as never);
    await CampaignService.startSending(projectId, created.id);
    const job = first.mock.calls[0]![0];
    first.mockRestore();

    await runChain(job, async batchNumber => {
      if (batchNumber === 2) {
        await contacts(2, {prefix: c0!.id.slice(0, 36), index: 4});
      }
      await markSent(created.id);
      await CampaignService.finalizeIfDone(created.id);
      expect((await prisma.campaign.findUniqueOrThrow({where: {id: created.id}})).status).toBe(CampaignStatus.SENDING);
    });
    await markSent(created.id);
    await CampaignService.finalizeIfDone(created.id);

    const done = await prisma.campaign.findUniqueOrThrow({where: {id: created.id}});
    expect(done).toMatchObject({status: CampaignStatus.SENT, totalRecipients: 6, sentCount: 6});
  });

  it('skips a batch left over from an earlier send of the campaign', async () => {
    await contacts(2);
    const campaign = await sendingCampaign(null);
    const sendToken = campaign.sentAt!.getTime();

    await runChain(firstBatch(campaign.id, sendToken - 60_000));
    expect(await prisma.email.count({where: {campaignId: campaign.id}})).toBe(0);

    await runChain(firstBatch(campaign.id, sendToken));
    expect(await prisma.email.count({where: {campaignId: campaign.id}})).toBe(2);
  });

  it('names the send in the batch job id, and passes the delay on', async () => {
    const add = vi.spyOn(campaignQueue, 'add').mockResolvedValue(undefined as never);

    await QueueService.queueCampaignBatch({campaignId: 'c', batchNumber: 2, offset: 0, limit: 500, sendToken: 42}, 300);
    await QueueService.queueCampaignBatch({campaignId: 'c', batchNumber: 2, offset: 0, limit: 500});

    expect(add.mock.calls[0]![2]).toEqual({jobId: 'campaign-c-42-batch-2', delay: 300});
    expect(add.mock.calls[1]![2]).toEqual({jobId: 'campaign-c-batch-2', delay: undefined});
  });

  it('changes the pace of a sending campaign, and nothing else about it', async () => {
    const campaign = await sendingCampaign(100);

    await CampaignService.update(projectId, campaign.id, {sendsPerHour: 600});
    expect((await prisma.campaign.findUniqueOrThrow({where: {id: campaign.id}})).sendsPerHour).toBe(600);
    await CampaignService.update(projectId, campaign.id, {sendsPerHour: null});
    expect((await prisma.campaign.findUniqueOrThrow({where: {id: campaign.id}})).sendsPerHour).toBeNull();

    await expect(CampaignService.update(projectId, campaign.id, {sendsPerHour: 50, subject: 'New'})).rejects.toThrow(
      'sending',
    );
    await expect(CampaignService.update(projectId, campaign.id, {subject: 'New'})).rejects.toThrow('sending');
  });

  it('queues campaign emails at the configured priority', async () => {
    const add = vi.spyOn(emailQueue, 'add').mockResolvedValue(undefined as never);

    await QueueService.queueEmail('00000000-0000-4000-8000-000000000001', EmailSourceType.CAMPAIGN);

    expect(add.mock.calls[0]![2]).toMatchObject({priority: CAMPAIGN_EMAIL_PRIORITY});
    expect(CAMPAIGN_EMAIL_PRIORITY).toBeGreaterThan(1);
  });
});
