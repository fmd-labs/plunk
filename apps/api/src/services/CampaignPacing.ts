/**
 * Campaign pacing (fork D36): a campaign may cap how many recipients it reaches per hour. The batch
 * chain is paced, not the emails: each batch takes at most a twelfth of the hourly cap, and the next
 * batch is queued with a delay that keeps the campaign under it. Emails are created per batch, so
 * none of them waits in the queue long enough for the stall sweep to fail it.
 */

/** A paced campaign runs in about this many batches per hour: one every five minutes. */
const PACED_BATCHES_PER_HOUR = 12;

const HOUR_MS = 60 * 60 * 1000;

/** How many recipients a batch takes: the chain's batch size, smaller for a paced campaign. */
export function pacedBatchSize(sendsPerHour: number | null | undefined, batchSize: number): number {
  if (!sendsPerHour) {
    return batchSize;
  }
  return Math.min(batchSize, Math.max(1, Math.ceil(sendsPerHour / PACED_BATCHES_PER_HOUR)));
}

/** How long to wait before the next batch, after one that took `recipients`; none without a cap. */
export function pacedDelayMs(sendsPerHour: number | null | undefined, recipients: number): number | undefined {
  if (!sendsPerHour || recipients === 0) {
    return undefined;
  }
  return Math.ceil((recipients / sendsPerHour) * HOUR_MS);
}
