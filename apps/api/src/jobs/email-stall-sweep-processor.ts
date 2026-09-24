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
 * Emails settled per run. Settling one can track `email.failed`, which runs the project's
 * workflows, so a mass loss of jobs is worked through over consecutive runs. Queueing an email
 * again is not counted: the time budget bounds it.
 */
const MAX_SETTLED_PER_RUN = 1000;

/**
 * How long a run looks. The next run goes on where this one stopped, so a long queue of emails
 * waiting their turn takes a few runs to look past.
 */
const RUN_BUDGET_MS = 30_000;

async function processSweep(_job: Job<EmailStallSweepJobData>): Promise<{requeued: number; settled: number}> {
  const result = await sweepStalledEmails({settle: MAX_SETTLED_PER_RUN, ms: RUN_BUDGET_MS});

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
