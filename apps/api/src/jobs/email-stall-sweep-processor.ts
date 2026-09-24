/**
 * Background Job: Stalled Email Sweep
 *
 * An email is settled by its job: sent and recorded, failed, or recorded as an unknown outcome.
 * The email worker settles the emails of the jobs it sees fail (see `settleFailedJob`), but some
 * emails are left PENDING or SENDING with no job to settle them: a job lost from Redis, a job that
 * failed for good while the database was unavailable, an email whose job could not be queued.
 * This sweep settles them (see `sweepStalledEmails`), the emails untouched the longest first.
 *
 * Runs every five minutes. Re-running is safe: every write is conditional on the email's status,
 * and an email whose job is back in the queue is left to it.
 */

import type {EmailStallSweepJobData} from '@plunk/types';
import {type Job, Worker} from 'bullmq';
import signale from 'signale';

import {emailStallSweepQueue} from '../services/QueueService.js';
import {sweepStalledEmails} from './email-processor.js';

/**
 * Emails looked at per run. Each costs a lookup of its job, and one whose job is still queued is
 * left alone, so a long queue of emails waiting their turn only delays the sweep of the others.
 */
const MAX_PER_RUN = 500;

async function processSweep(_job: Job<EmailStallSweepJobData>): Promise<{requeued: number; settled: number}> {
  const result = await sweepStalledEmails(MAX_PER_RUN);

  if (result.requeued > 0 || result.settled > 0) {
    signale.info(`[EMAIL-STALL-SWEEP] Queued ${result.requeued} stalled email(s) again and settled ${result.settled}`);
  }

  return result;
}

export function createEmailStallSweepWorker(): Worker<EmailStallSweepJobData> {
  const worker = new Worker<EmailStallSweepJobData>(emailStallSweepQueue.name, processSweep, {
    connection: emailStallSweepQueue.opts.connection,
    // One sweep at a time: two runs would look at the same emails.
    concurrency: 1,
  });

  worker.on('failed', (job, error) => {
    signale.error(`[EMAIL-STALL-SWEEP] Job ${job?.id} failed:`, error);
  });

  worker.on('error', error => {
    signale.error('[EMAIL-STALL-SWEEP] Worker error:', error);
  });

  return worker;
}
