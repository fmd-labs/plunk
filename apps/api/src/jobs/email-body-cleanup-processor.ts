import type {EmailBodyCleanupJobData} from '@plunk/types';
import type {Job} from 'bullmq';
import {Worker} from 'bullmq';
import type {RedisOptions} from 'ioredis';
import signale from 'signale';

import {EMAIL_BODY_RETENTION_DAYS, REDIS_URL} from '../app/constants.js';
import {prisma} from '../database/prisma.js';

/**
 * Email Body Cleanup Worker
 * Blanks the rendered HTML body of emails past the retention window
 * (`EMAIL_BODY_RETENTION_DAYS`, 90 by default; 0 keeps every body). The row is kept
 * so delivery history, event counts and analytics stay intact; only the body — by far
 * the largest column — is dropped. Runs daily.
 */

const BATCH_SIZE = 1000; // Update in batches to avoid long-held row locks

/**
 * Process email body cleanup job
 */
export async function processCleanup(
  job: Job<EmailBodyCleanupJobData>,
  retentionDays = EMAIL_BODY_RETENTION_DAYS,
): Promise<{cleared: number}> {
  if (retentionDays === 0) {
    signale.info('[EMAIL-BODY-CLEANUP] EMAIL_BODY_RETENTION_DAYS is 0, keeping every email body');
    await job.updateProgress(100);
    return {cleared: 0};
  }

  signale.info('[EMAIL-BODY-CLEANUP] Starting cleanup of email bodies past retention...');

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

  let totalCleared = 0;

  try {
    for (;;) {
      // updateMany has no LIMIT, so bound each statement with a subselect. The
      // `body <> ''` predicate keeps already-cleared rows out of every later batch
      // and is served by the partial index emails_createdAt_unpurged_idx. An email
      // still waiting to be sent keeps its body, which the worker sends as it finds
      // it: with a short retention, a large or slow send can outlast the window. An email
      // that never leaves PENDING or SENDING keeps its body, and each batch reads past it.
      const cleared = await prisma.$executeRaw`
        UPDATE "emails"
        SET "body" = ''
        WHERE "id" IN (
          SELECT "id" FROM "emails"
          WHERE "createdAt" < ${cutoffDate}
            AND "body" <> ''
            AND "status" NOT IN ('PENDING', 'SENDING')
          ORDER BY "createdAt"
          LIMIT ${BATCH_SIZE}
        )
      `;

      totalCleared += cleared;

      if (cleared < BATCH_SIZE) {
        break;
      }

      signale.info(`[EMAIL-BODY-CLEANUP] Cleared ${totalCleared} bodies so far, continuing...`);
      // Small delay between batches to reduce database load
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    signale.success(
      `[EMAIL-BODY-CLEANUP] Cleanup complete. Cleared ${totalCleared} bodies older than ${retentionDays} days (before ${cutoffDate.toISOString()})`,
    );

    await job.updateProgress(100);

    return {cleared: totalCleared};
  } catch (error) {
    signale.error('[EMAIL-BODY-CLEANUP] Error during cleanup:', error);
    throw error;
  }
}

/**
 * Create the email body cleanup worker
 */
export function createEmailBodyCleanupWorker(): Worker<EmailBodyCleanupJobData> {
  const redisConnection: RedisOptions = {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    ...parseRedisUrl(REDIS_URL),
  };

  // Wrapped: BullMQ passes a lock token as the second argument, which is not a retention.
  const worker = new Worker<EmailBodyCleanupJobData>('email-body-cleanup', job => processCleanup(job), {
    connection: redisConnection,
    concurrency: 1, // Only run one cleanup job at a time
  });

  worker.on('completed', job => {
    signale.success(`[EMAIL-BODY-CLEANUP] Job ${job.id} completed:`, job.returnvalue);
  });

  worker.on('failed', (job, err) => {
    signale.error(`[EMAIL-BODY-CLEANUP] Job ${job?.id} failed:`, err);
  });

  worker.on('error', err => {
    signale.error('[EMAIL-BODY-CLEANUP] Worker error:', err);
  });

  return worker;
}

function parseRedisUrl(url: string): {host: string; port: number; password?: string; db?: number} {
  const urlObj = new URL(url);
  return {
    host: urlObj.hostname,
    port: parseInt(urlObj.port || '6379', 10),
    password: urlObj.password || undefined,
    db: parseInt(urlObj.pathname.slice(1) || '0', 10),
  };
}
