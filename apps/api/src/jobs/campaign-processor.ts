/**
 * Background Job: Campaign Processor
 * Processes campaign batches (queues emails for each contact in the batch)
 */

import type {CampaignBatchJobData} from '@plunk/types';
import {type Job, Worker} from 'bullmq';
import signale from 'signale';

import {CampaignService} from '../services/CampaignService.js';
import {campaignQueue} from '../services/QueueService.js';

export function createCampaignWorker() {
  const worker = new Worker<CampaignBatchJobData>(
    campaignQueue.name,
    async (job: Job<CampaignBatchJobData>) => {
      const {campaignId, batchNumber, offset, limit, cursor, sendToken, reached} = job.data;

      signale.info(`[CAMPAIGN-PROCESSOR] Processing batch ${batchNumber} for campaign ${campaignId}`);

      await CampaignService.processBatch(campaignId, batchNumber, offset, limit, cursor, {sendToken, reached});

      signale.info(`[CAMPAIGN-PROCESSOR] Completed batch ${batchNumber} for campaign ${campaignId}`);
    },
    {
      connection: campaignQueue.opts.connection,
      concurrency: 5, // Process up to 5 batches concurrently
    },
  );

  worker.on('completed', job => {
    signale.info(`[CAMPAIGN-PROCESSOR] Job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    signale.error(`[CAMPAIGN-PROCESSOR] Job ${job?.id} failed:`, err.message);
  });

  worker.on('error', err => {
    signale.error('[CAMPAIGN-PROCESSOR] Worker error:', err);
  });

  return worker;
}
