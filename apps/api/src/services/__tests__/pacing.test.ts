import {CampaignStatus, EmailSourceType} from '@plunk/db';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {CAMPAIGN_EMAIL_PRIORITY} from '../../app/constants';
import {pacedBatchSize, pacedDelayMs} from '../CampaignPacing';
import {CampaignService} from '../CampaignService';
import {emailQueue, QueueService} from '../QueueService';

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

  it('splits an hour into twelve batches, and waits for each batch’s share of it', () => {
    expect(pacedBatchSize(null, 500)).toBe(500);
    expect(pacedBatchSize(1200, 500)).toBe(100);
    expect(pacedBatchSize(100_000, 500)).toBe(500);
    expect(pacedBatchSize(5, 500)).toBe(1);

    expect(pacedDelayMs(null, 500)).toBeUndefined();
    expect(pacedDelayMs(1200, 100)).toBe(5 * 60 * 1000);
    expect(pacedDelayMs(1200, 0)).toBeUndefined();
  });

  it('sends a paced campaign a batch at a time, queueing the next one after the batch’s share of the hour', async () => {
    for (let i = 0; i < 5; i++) {
      await factories.createContact({projectId, email: `c${i}@example.com`});
    }
    const campaign = await factories.createCampaign({projectId, status: CampaignStatus.SENDING});
    await prisma.campaign.update({where: {id: campaign.id}, data: {sendsPerHour: 24}});
    const next = vi.spyOn(QueueService, 'queueCampaignBatch').mockResolvedValue(undefined as never);

    await CampaignService.processBatch(campaign.id, 1, 0, 500);

    expect(await prisma.email.count({where: {campaignId: campaign.id}})).toBe(2);
    expect(next).toHaveBeenCalledTimes(1);
    const [data, delay] = next.mock.calls[0]!;
    expect(data).toMatchObject({campaignId: campaign.id, batchNumber: 2, limit: 500});
    expect(delay).toBe(5 * 60 * 1000);
  });

  it('sends an unpaced campaign in full batches, without a delay', async () => {
    for (let i = 0; i < 3; i++) {
      await factories.createContact({projectId, email: `c${i}@example.com`});
    }
    const campaign = await factories.createCampaign({projectId, status: CampaignStatus.SENDING});

    await CampaignService.processBatch(campaign.id, 1, 0, 2);

    expect(await prisma.email.count({where: {campaignId: campaign.id}})).toBe(2);
  });

  it('queues campaign emails at the configured priority', async () => {
    const add = vi.spyOn(emailQueue, 'add').mockResolvedValue(undefined as never);

    await QueueService.queueEmail('00000000-0000-4000-8000-000000000001', EmailSourceType.CAMPAIGN);

    expect(add.mock.calls[0]![2]).toMatchObject({priority: CAMPAIGN_EMAIL_PRIORITY});
    expect(CAMPAIGN_EMAIL_PRIORITY).toBe(10);
  });
});
