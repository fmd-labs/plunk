/**
 * Background Job: Stalled Email Sweep
 *
 * An email is settled by its job: sent and recorded, failed, or recorded as an unknown outcome.
 * The email worker settles the emails of the jobs it sees fail (see `settleFailedJob`), but some
 * emails are left PENDING or SENDING with no job to settle them: a job lost from Redis, a job that
 * failed for good while the database was unavailable, an email whose job could not be queued.
 * This sweep settles them (see `sweepStalledEmails`), the emails untouched the longest first.
 *
 * Runs every five minutes, unless `EMAIL_STALL_SWEEP_ENABLED` is false. Re-running is safe: every
 * write is conditional on the email's status, and an email whose job is back in the queue is left
 * to it.
 */

import {type Email, EmailStatus, type Prisma} from '@plunk/db';
import type {EmailStallSweepJobData, SendEmailJobData} from '@plunk/types';
import {type Job, Worker} from 'bullmq';
import signale from 'signale';

import {EMAIL_STALL_SWEEP_ENABLED, EMAIL_STALL_SWEEP_MAX_AGE_HOURS} from '../app/constants.js';
import {prisma} from '../database/prisma.js';
import {redis} from '../database/redis.js';
import {Keys} from '../services/keys.js';
import {emailQueue, emailStallSweepQueue, QueueService, storedPriority} from '../services/QueueService.js';
import {
  type FailedEmail,
  markTerminalFailure,
  recordTerminalFailure,
  type SettleOutcome,
  settleFailedJob,
  unknownOutcome,
} from './email-processor.js';

/** How long an email stays PENDING or SENDING without a job before the sweep settles it. */
const STALLED_AFTER_MS = 15 * 60 * 1000;

/** The states of a job that will still send its email or record the outcome. */
const LIVE_JOB_STATES = new Set(['waiting', 'prioritized', 'delayed', 'active', 'waiting-children']);

/**
 * Emails read per page. A page reads only their ids and times: sorting it is what a page costs,
 * as no index serves its order, so a narrow page can be long and a pass through millions of
 * emails takes few of them.
 */
const PAGE_SIZE = 20_000;

/**
 * How many job states the sweep asks Redis for at once. Each lookup also costs this process some
 * work, which the email worker waits behind: batches keep each stretch of it short.
 */
const JOB_STATE_BATCH = 500;

/**
 * Emails settled per run. Settling one can track `email.failed`, which runs the project's
 * workflows, so a mass loss of jobs is worked through over consecutive runs. Queueing an email
 * again, and failing one without reporting it, is not counted: the time budget bounds those.
 */
const MAX_SETTLED_PER_RUN = 1000;

/**
 * How long a run looks. The next run goes on where this one stopped, so a long queue of emails
 * waiting their turn takes a few runs to look past.
 */
const RUN_BUDGET_MS = 30_000;

type SweepPass = 'direct' | 'campaign';

/**
 * A run's two passes, each with its own place (`Keys.Email.stallSweepCursor`): the emails of no
 * campaign (transactional and workflow emails, found through the `(campaignId, status)` index), then
 * campaign emails. A large campaign can keep millions of emails waiting their turn; a transactional
 * email left without a job is found by the next run all the same.
 */
const PASSES: {name: SweepPass; where: Prisma.EmailWhereInput}[] = [
  {name: 'direct', where: {campaignId: null}},
  {name: 'campaign', where: {campaignId: {not: null}}},
];

/** The fields of an email the sweep settles. */
const STALLED_EMAIL = {
  id: true,
  status: true,
  headers: true,
  createdAt: true,
  projectId: true,
  contactId: true,
  campaignId: true,
  templateId: true,
  sourceType: true,
  subject: true,
  from: true,
  fromName: true,
  project: {select: {disabled: true}},
} satisfies Prisma.EmailSelect;

type StalledEmail = FailedEmail &
  Pick<Email, 'status' | 'headers' | 'createdAt'> & {
    project: {disabled: boolean};
  };

/** What a run did: emails queued again, failed and reported, and failed without a report. */
export interface SweepResult {
  requeued: number;
  settled: number;
  closed: number;
}

/** Where a pass stopped: the last email it looked at, in the order it pages. */
type SweepCursor = {updatedAt: Date; id: string};

/** Where the pass stopped last, unless it reached the end. A place that cannot be read is ignored. */
async function readSweepCursor(pass: SweepPass): Promise<SweepCursor | undefined> {
  const stored = await redis.get(Keys.Email.stallSweepCursor(pass));
  if (!stored) {
    return undefined;
  }
  try {
    const {updatedAt, id} = JSON.parse(stored) as {updatedAt: string; id: string};
    const cursor = {updatedAt: new Date(updatedAt), id};
    if (typeof id === 'string' && !Number.isNaN(cursor.updatedAt.getTime())) {
      return cursor;
    }
  } catch {
    // Not JSON, or not an object: started over below.
  }
  signale.warn(`[EMAIL-STALL-SWEEP] Starting the ${pass} pass over: cannot read where it stopped (${stored})`);
  return undefined;
}

async function saveSweepCursor(pass: SweepPass, cursor: SweepCursor | undefined): Promise<void> {
  if (cursor) {
    await redis.set(Keys.Email.stallSweepCursor(pass), JSON.stringify(cursor));
  } else {
    await redis.del(Keys.Email.stallSweepCursor(pass));
  }
}

/**
 * Settle one email left PENDING or SENDING whose job, in `state`, will not send it or record its
 * outcome.
 */
async function settleStalledEmail(email: StalledEmail, state: string, maxAgeMs: number): Promise<SettleOutcome> {
  const job: Job<SendEmailJobData> | undefined = await emailQueue.getJob(`email-${email.id}`);

  if (job?.data.acceptedBySes) {
    // Run the job again from its checkpoint, which records the message SES accepted, however long
    // ago, ahead of the prioritized jobs, as a retry is. A job in no queue list cannot be retried
    // and is added again, after its checkpoint is logged: the job holds its only copy.
    if (state === 'completed' || state === 'failed') {
      await job.retry(state);
    } else {
      signale.warn(
        `[EMAIL-STALL-SWEEP] Queueing again the job of email ${email.id}, which holds SES message ${job.data.acceptedBySes.messageId}`,
      );
      await job.remove();
      await emailQueue.add(job.name, job.data, {jobId: job.id});
    }
    return 'requeued';
  }

  // Too old to send late, which could deliver a one-time code or a campaign days after the fact,
  // such as the emails an upstream version left behind before an upgrade; and too old to report,
  // since `email.failed` runs the project's workflows. Failed without either.
  if (Date.now() - email.createdAt.getTime() >= maxAgeMs) {
    const hours = maxAgeMs / 3_600_000;
    const age = `more than ${hours} hour${hours === 1 ? '' : 's'} after it was created`;
    const error =
      email.status === EmailStatus.SENDING
        ? unknownOutcome(`its job was lost, found ${age}`)
        : `Not sent: left without a job to send it, found ${age}`;
    return (await recordTerminalFailure(email, email.status, error)) ? 'closed' : undefined;
  }

  if (job && state === 'failed') {
    return settleFailedJob(job, new Error(job.failedReason || 'The job sending the email failed'));
  }

  if (email.status === EmailStatus.PENDING) {
    // A disabled project sends nothing: its email is failed as disabling the project fails the
    // emails it takes out of the queue (`cancelAllProjectJobs`), without a report.
    if (email.project.disabled) {
      return (await recordTerminalFailure(email, EmailStatus.PENDING, 'Project is disabled')) ? 'closed' : undefined;
    }
    // A finished job keeps its id, under which the queue would not take a new job.
    await job?.remove();
    await QueueService.queueEmail(email.id, email.sourceType, undefined, storedPriority(email.headers));
    return 'requeued';
  }

  const failed = await markTerminalFailure(email, EmailStatus.SENDING, unknownOutcome('its job was lost'), {
    reason: 'stalled_without_checkpoint',
    attempts: job?.attemptsMade || 1,
  });
  return failed ? 'settled' : undefined;
}

/**
 * One pass of a run, from where it stopped last until `deadline` or the settle limit, or to the
 * end, after which the next run starts it over. It works through at least the first batch of each
 * page it reads, however long reading it took, so that a slow read cannot keep every run from
 * getting anywhere.
 */
async function sweepPass(
  pass: (typeof PASSES)[number],
  limits: {settle: number; deadline: number; pageSize: number; batchSize: number; maxAgeMs: number},
  result: SweepResult,
): Promise<void> {
  const cutoff = new Date(Date.now() - STALLED_AFTER_MS);
  let after = await readSweepCursor(pass.name);

  for (let firstPage = true; ; firstPage = false) {
    if (!firstPage && Date.now() >= limits.deadline) {
      return saveSweepCursor(pass.name, after);
    }
    // Every PENDING and SENDING email of the pass is read and sorted for a page, through the
    // status index (or `(campaignId, status)` for the emails of no campaign): cheap while there are
    // few of them, about a second a page with millions.
    const page = await prisma.email.findMany({
      where: {
        ...pass.where,
        status: {in: [EmailStatus.PENDING, EmailStatus.SENDING]},
        updatedAt: {lt: cutoff},
        ...(after ? {OR: [{updatedAt: {gt: after.updatedAt}}, {updatedAt: after.updatedAt, id: {gt: after.id}}]} : {}),
      },
      orderBy: [{updatedAt: 'asc'}, {id: 'asc'}],
      take: limits.pageSize,
      select: {id: true, updatedAt: true},
    });

    for (let start = 0; start < page.length; start += limits.batchSize) {
      const firstBatch = start === 0;
      if (!firstBatch && Date.now() >= limits.deadline) {
        return saveSweepCursor(pass.name, after);
      }
      const batch = page.slice(start, start + limits.batchSize);
      // A batch's lookups go out at once, without waiting for each other's answers.
      const states = await Promise.all(batch.map(({id}) => emailQueue.getJobState(`email-${id}`)));
      const lost = batch.filter((_, index) => !LIVE_JOB_STATES.has(states[index]!)).map(({id}) => id);
      // Read again, as each may have been settled since the page was read.
      const stalled = new Map(
        lost.length === 0
          ? []
          : (
              await prisma.email.findMany({
                where: {id: {in: lost}, status: {in: [EmailStatus.PENDING, EmailStatus.SENDING]}},
                select: STALLED_EMAIL,
              })
            ).map(email => [email.id, email]),
      );

      for (const [index, {id, updatedAt}] of batch.entries()) {
        const email = stalled.get(id);
        if (email) {
          if (result.settled >= limits.settle || (!firstBatch && Date.now() >= limits.deadline)) {
            return saveSweepCursor(pass.name, after);
          }
          try {
            const outcome = await settleStalledEmail(email, states[index]!, limits.maxAgeMs);
            if (outcome) {
              result[outcome] += 1;
            }
          } catch (error) {
            signale.error(`[EMAIL-STALL-SWEEP] Failed to settle stalled email ${id}:`, error);
          }
        }
        after = {updatedAt, id};
      }
    }

    if (page.length < limits.pageSize) {
      // The end: the next run starts this pass over from the email untouched the longest.
      return saveSweepCursor(pass.name, undefined);
    }
  }
}

/**
 * Settle the emails left PENDING or SENDING for 15 minutes or more without a job that will send
 * them or record their outcome: a job lost from Redis, a job that failed for good while its email
 * could not be written, or an email whose job could not be queued. Emails of no campaign first
 * (with half the time at most), then campaign emails, each pass from the one untouched the longest,
 * going on where the last run stopped; an email whose job still waits or runs is left to it. Stops
 * after `limits.ms`, or once it has settled `limits.settle` emails.
 *
 * - A job that holds an SES acceptance runs again, which records it.
 * - An email created `limits.maxAgeMs` or longer ago is failed without being sent or reported: a
 *   PENDING one as not sent, a SENDING one as an unknown outcome.
 * - A job that failed for good settles its email as `settleFailedJob` does.
 * - A PENDING email is queued again, with the priority it was sent with, unless its project is
 *   disabled, which fails it without a report.
 * - Any other SENDING email is failed as an unknown outcome.
 */
export async function sweepStalledEmails(limits: {
  settle: number;
  ms: number;
  maxAgeMs?: number;
  /** For tests: emails per page, and job states asked for at once. */
  pageSize?: number;
  batchSize?: number;
}): Promise<SweepResult> {
  const result: SweepResult = {requeued: 0, settled: 0, closed: 0};
  const started = Date.now();
  const options = {
    settle: limits.settle,
    pageSize: limits.pageSize ?? PAGE_SIZE,
    batchSize: limits.batchSize ?? JOB_STATE_BATCH,
    maxAgeMs: limits.maxAgeMs ?? EMAIL_STALL_SWEEP_MAX_AGE_HOURS * 3_600_000,
  };

  // The emails of no campaign get half the time at most, so that a long pass through them cannot
  // keep the campaign pass from running.
  await sweepPass(PASSES[0]!, {...options, deadline: started + limits.ms / 2}, result);
  if (result.settled < limits.settle) {
    await sweepPass(PASSES[1]!, {...options, deadline: started + limits.ms}, result);
  }
  return result;
}

/** A run of the sweep, unless `EMAIL_STALL_SWEEP_ENABLED` turned it off. Exported for tests. */
export async function processSweep(enabled = EMAIL_STALL_SWEEP_ENABLED): Promise<SweepResult> {
  if (!enabled) {
    return {requeued: 0, settled: 0, closed: 0};
  }

  const result = await sweepStalledEmails({settle: MAX_SETTLED_PER_RUN, ms: RUN_BUDGET_MS});

  if (result.requeued > 0 || result.settled > 0 || result.closed > 0) {
    signale.info(
      `[EMAIL-STALL-SWEEP] Queued ${result.requeued} stalled email(s) again, failed ${result.settled}, and failed ${result.closed} without a report (too old to send, or of a disabled project)`,
    );
  }

  return result;
}

export function createEmailStallSweepWorker(): Worker<EmailStallSweepJobData> {
  if (!EMAIL_STALL_SWEEP_ENABLED) {
    signale.warn(
      '[EMAIL-STALL-SWEEP] Disabled by EMAIL_STALL_SWEEP_ENABLED=false: emails left without a job are not sent or settled',
    );
  }

  // Wrapped: BullMQ passes the job and a lock token, which are not the switch.
  const worker = new Worker<EmailStallSweepJobData>(emailStallSweepQueue.name, () => processSweep(), {
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
