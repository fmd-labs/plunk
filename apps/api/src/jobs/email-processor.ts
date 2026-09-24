/**
 * Background Job: Email Processor
 * Processes individual emails from the queue (for all sources: transactional, campaign, workflow)
 *
 * This is the only send path. `EmailService.sendEmail` used to hold a second copy of it, tested
 * while this one was not, and the two had drifted; it has been removed. The behaviour those tests
 * claimed to cover -- PENDING → SENDING → SENT, the failure transition, send idempotency, and
 * attachments reaching SES -- is implemented here. Integration tests exercise it through real
 * queue jobs; keep new assertions on this path rather than reviving a second send implementation.
 */

import {CampaignStatus, type Email, EmailStatus} from '@plunk/db';
import {isMailboxSimulatorAddress} from '@plunk/shared';
import type {SendEmailJobData} from '@plunk/types';
import {DelayedError, type Job, UnrecoverableError, Worker} from 'bullmq';
import signale from 'signale';

import {
  DASHBOARD_URI,
  EMAIL_RATE_LIMIT_PER_SECOND,
  EMAIL_WORKER_CONCURRENCY,
  EMAIL_WORKER_MAX_CONCURRENCY,
} from '../app/constants.js';
import {prisma} from '../database/prisma.js';
import {CampaignService} from '../services/CampaignService.js';
import {
  bodyHasListManagementLink,
  buildEmailHeaders,
  classifyEmail,
  isInternalHeader,
  TEMPLATING_HEADER,
  withSourceEmail,
} from '../services/EmailHeaderService.js';
import {EmailService} from '../services/EmailService.js';
import {EventService} from '../services/EventService.js';
import {MeterService} from '../services/MeterService.js';
import {emailQueue} from '../services/QueueService.js';
import {SecurityService} from '../services/SecurityService.js';
import {buildRawEmail, getSendingQuota, submitRawEmail} from '../services/SESService.js';
import {classifySendFailure, SES_OUTCOME_UNKNOWN} from '../utils/sesSendFailure.js';

/**
 * Determine the email sending rate limit (emails per second)
 * Priority: ENV variable > AWS SES quota > Safe default (14)
 */
async function getEmailRateLimit(): Promise<number> {
  const DEFAULT_RATE_LIMIT = 14; // AWS SES sandbox limit - safe default

  // If env variable is set, use it (override)
  if (EMAIL_RATE_LIMIT_PER_SECOND !== undefined) {
    signale.info(`[EMAIL-PROCESSOR] Using rate limit from environment: ${EMAIL_RATE_LIMIT_PER_SECOND} emails/second`);
    return EMAIL_RATE_LIMIT_PER_SECOND;
  }

  // Try to fetch from AWS SES
  signale.info('[EMAIL-PROCESSOR] Fetching rate limit from AWS SES...');
  const quota = await getSendingQuota();

  if (quota) {
    signale.info(
      `[EMAIL-PROCESSOR] AWS SES quota: ${quota.maxSendRate} emails/second (${quota.sentLast24Hours}/${quota.max24HourSend} emails sent today)`,
    );
    return quota.maxSendRate;
  }

  // Fallback to safe default
  signale.warn(`[EMAIL-PROCESSOR] Failed to fetch AWS quota, using safe default: ${DEFAULT_RATE_LIMIT} emails/second`);
  return DEFAULT_RATE_LIMIT;
}

/**
 * Derive worker concurrency from the rate limit so a higher SES quota actually
 * translates into higher throughput. The mean job duration is ~0.5s (Prisma
 * reads + HTML compile + SES call + writes), so `rate * 0.5` gives ~2× headroom
 * over the per-second cap. Clamped to keep sandbox accounts useful and to
 * protect the Prisma pool on very large quotas.
 */
function deriveWorkerConcurrency(rateLimit: number): number {
  if (EMAIL_WORKER_CONCURRENCY !== undefined) {
    return EMAIL_WORKER_CONCURRENCY;
  }

  const TARGET_JOB_SECONDS = 0.5;
  const MIN_CONCURRENCY = 5;
  const derived = Math.ceil(rateLimit * TARGET_JOB_SECONDS);
  return Math.max(MIN_CONCURRENCY, Math.min(derived, EMAIL_WORKER_MAX_CONCURRENCY));
}

type SesAcceptance = {messageId: string; sentAt: Date};

/**
 * How long a run that lost its claim to another run of the same email waits before it looks at the
 * email again. That other run is alive, as BullMQ ran the job again after it stalled, and is done
 * within this time: the SES client gives up on a call after 35 s.
 */
const CLAIM_RECHECK_MS = 120_000;

/**
 * The wait before trying again to record a message SES accepted: as long as it has been since the
 * acceptance, from 1 s up to 2 minutes.
 */
function recordRetryDelay(accepted: SesAcceptance): number {
  return Math.min(120_000, Math.max(1_000, Date.now() - accepted.sentAt.getTime()));
}

/**
 * Run the job again after `delayMs` instead of finishing it now. Unlike a retry, this spends none of
 * the job's attempts, which are for sending the email: recording a message SES accepted, or waiting
 * for another run of the email, is not a send.
 */
async function runAgainLater(job: Job<SendEmailJobData>, token: string | undefined, delayMs: number): Promise<never> {
  await job.moveToDelayed(Date.now() + delayMs, token);
  throw new DelayedError();
}

/**
 * Thrown from the send path when another run of the email holds it, so that the job is moved to wait
 * outside the send path: a failure to move it is not a failure to send the email.
 */
class HeldByAnotherRun extends Error {}

async function checkpointSesAcceptance(job: Job<SendEmailJobData>, accepted: SesAcceptance): Promise<boolean> {
  try {
    await job.updateData({
      ...job.data,
      acceptedBySes: {
        messageId: accepted.messageId,
        sentAt: accepted.sentAt.toISOString(),
      },
    });
    return true;
  } catch (error) {
    signale.error(
      `[EMAIL-PROCESSOR] Failed to checkpoint SES acceptance of ${accepted.messageId} for ${job.data.emailId}:`,
      error,
    );
    return false;
  }
}

/** The error recorded for an email that is not sent again because SES may already have accepted it. */
function unknownOutcome(reason: string): string {
  return `${SES_OUTCOME_UNKNOWN}: ${reason}; not retried to avoid a duplicate`;
}

/**
 * Run a step that follows a recorded send without letting it fail the email: the message is out,
 * so a failure here must neither mark it failed nor send it again, nor skip the steps after it.
 */
async function bestEffort(emailId: string, step: string, action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (error) {
    signale.error(`[EMAIL-PROCESSOR] ${step} failed for email ${emailId}:`, error);
  }
}

/** Why an email will not be sent, as the `email.failed` event reports it. */
type FailureReason =
  | 'attempts_exhausted'
  | 'ses_rejected'
  | 'ses_outcome_unknown'
  | 'stalled_without_checkpoint'
  | 'project_disabled'
  | 'phishing_blocked';

/** The fields of an email a terminal failure records and reports. */
type FailedEmail = Pick<
  Email,
  'id' | 'projectId' | 'contactId' | 'campaignId' | 'templateId' | 'sourceType' | 'subject' | 'from' | 'fromName'
>;

/**
 * Record that an email will not be sent, or that whether it was sent cannot be known, report it as
 * `email.failed`, and let its campaign finish. Conditional on the email still being unsent and in
 * `from`, the status this run found it in or claimed it with, so it never overwrites another run's
 * claim or outcome, and only the run that records the failure reports it. `attempts` counts the
 * job's runs, this one included. Returns whether it recorded the failure.
 */
async function markTerminalFailure(
  email: FailedEmail,
  from: EmailStatus,
  error: string,
  failure: {reason: FailureReason; attempts: number},
): Promise<boolean> {
  const {count} = await prisma.email.updateMany({
    where: {id: email.id, status: from, sentAt: null},
    data: {status: EmailStatus.FAILED, error},
  });

  if (count > 0) {
    await bestEffort(email.id, 'Tracking email.failed', () =>
      EventService.trackEvent(email.projectId, 'email.failed', email.contactId, email.id, {
        subject: email.subject,
        from: email.from,
        fromName: email.fromName,
        messageId: null,
        emailId: email.id,
        templateId: email.templateId,
        campaignId: email.campaignId,
        sourceType: email.sourceType,
        error,
        reason: failure.reason,
        attempts: failure.attempts,
        failedAt: new Date().toISOString(),
      }),
    );
  }

  // A failed email is terminal for its campaign, which must not stay SENDING waiting for it.
  const campaignId = email.campaignId;
  if (count > 0 && campaignId) {
    await bestEffort(email.id, 'Finalizing the campaign', () => CampaignService.finalizeIfDone(campaignId));
  }
  return count > 0;
}

/**
 * Fail an email whose campaign stopped sending (cancelled, or reverted to a draft) after the email
 * was queued. Conditional on the email still being PENDING, so it never overwrites another run's
 * claim or outcome.
 */
async function failForStoppedCampaign(
  email: {id: string; campaignId: string | null},
  campaignStatus: CampaignStatus,
): Promise<void> {
  signale.warn(`[EMAIL-PROCESSOR] Campaign ${email.campaignId} is ${campaignStatus}, skipping email ${email.id}`);
  await prisma.email.updateMany({
    where: {id: email.id, status: EmailStatus.PENDING},
    data: {status: EmailStatus.FAILED, error: `Campaign ${campaignStatus.toLowerCase()}`},
  });
}

/**
 * Process one email job: load the email, run the pre-send checks, send it through SES and record
 * the outcome. Exported so the send path can be exercised without starting a worker.
 */
export async function processEmailJob(job: Job<SendEmailJobData>, token?: string): Promise<void> {
  const {emailId} = job.data;

  const recoveredAcceptance = job.data.acceptedBySes
    ? {
        messageId: job.data.acceptedBySes.messageId,
        sentAt: new Date(job.data.acceptedBySes.sentAt),
      }
    : undefined;

  const email = await prisma.email
    .findUnique({
      where: {id: emailId},
      include: {
        contact: true,
        project: true,
        template: {select: {type: true}},
        campaign: {select: {type: true, status: true}},
      },
    })
    .catch((error: unknown) => {
      if (!recoveredAcceptance) {
        throw error;
      }
      // SES accepted the message, which only has to be recorded: wait for the database.
      signale.error(
        `[EMAIL-PROCESSOR] Failed to load email ${emailId} to record SES message ${recoveredAcceptance.messageId}:`,
        error,
      );
      return runAgainLater(job, token, recordRetryDelay(recoveredAcceptance));
    });

  // A missing row is now an expected outcome rather than an error: cancelling a
  // campaign before it sent anything deletes its unsent emails in the background,
  // and every job already queued for them arrives here to find nothing. Throwing
  // would put each one through three retries and into the failed set -- millions
  // of executions for a large campaign, burying real failures. There is nothing to
  // send and nothing to record, so the job is simply done.
  if (!email) {
    // A checkpointed acceptance means SES has the message: log its ID so the delivery can be traced.
    const accepted = recoveredAcceptance ? ` (SES accepted it as ${recoveredAcceptance.messageId})` : '';
    signale.warn(`[EMAIL-PROCESSOR] Email ${emailId} no longer exists, skipping${accepted}`);
    return;
  }

  if (email.status === EmailStatus.SENDING && !recoveredAcceptance) {
    // An email is claimed right before it is handed to SES, so an earlier run stopped (or lost its
    // job) between the claim and recording SES's answer: SES may have accepted it.
    const message = unknownOutcome('an earlier attempt stopped while sending it');
    await markTerminalFailure(email, EmailStatus.SENDING, message, {
      reason: 'stalled_without_checkpoint',
      attempts: job.attemptsMade + 1,
    });
    throw new UnrecoverableError(message);
  }

  if (email.status !== EmailStatus.PENDING && !(email.status === EmailStatus.SENDING && recoveredAcceptance)) {
    return;
  }

  // A campaign that was cancelled (or reverted to draft) after this job was
  // queued must not keep sending. `CampaignService.processBatch` stops the batch
  // chain on its own status check, but the per-email jobs it already created are
  // in this queue and would otherwise ship regardless -- which is what made a
  // cancel of a SENDING campaign a relabel rather than a stop. Marking the email
  // FAILED rather than deleting it keeps the row that `cancel` counts when it
  // decides whether the campaign is still reversible.
  //
  // Skipped for a checkpointed SES acceptance: that message already left, so the
  // retry must record it as SENT (which also keeps the campaign CANCELLED) rather
  // than FAILED, which `hasDepartedEmail` would read as never sent.
  if (!recoveredAcceptance && email.campaign && email.campaign.status !== CampaignStatus.SENDING) {
    await failForStoppedCampaign(email, email.campaign.status);

    // No `finalizeIfDone` here: it only advances a campaign that is still
    // SENDING, and this branch runs precisely when it is not.
    return;
  }

  // Check if project is disabled. The failure is terminal for the campaign, which
  // `markTerminalFailure` finalizes so it doesn't stay stuck in SENDING forever
  // waiting on emails that will never be sent.
  if (email.project.disabled && !recoveredAcceptance) {
    signale.warn(`[EMAIL-PROCESSOR] Project ${email.projectId} is disabled, cancelling email ${emailId}`);
    await markTerminalFailure(email, EmailStatus.PENDING, 'Project is disabled', {
      reason: 'project_disabled',
      attempts: job.attemptsMade + 1,
    });
    return;
  }

  // Parse custom headers from JSON
  const customHeaders =
    email.headers && typeof email.headers === 'object' && !Array.isArray(email.headers)
      ? (email.headers as Record<string, string>)
      : undefined;

  // Check for custom recipient override in headers. Resolved before the try so the
  // catch can stamp `simulated` when it persists an accepted message itself.
  const recipientEmail = customHeaders?.['X-Plunk-Recipient-Override'] || email.contact.email;

  let acceptedBySes: SesAcceptance | undefined = recoveredAcceptance;
  let acceptanceCheckpointed = recoveredAcceptance !== undefined;
  // Set once the message is handed to SES: from then on, what the failure says about SES's answer
  // decides whether another attempt is safe. Set right after the claim, so it also tells whether
  // this run holds the email.
  let submitted = false;
  // The formatted subject, for the `email.sent` event.
  let subject = email.subject;

  // Mark as sent with SES message ID.
  //
  // Guarded on `sentAt` still being null so the campaign counter is only
  // incremented by the run that actually stamped it. A job retried after SES
  // accepted the message would otherwise count the same email twice. Returns
  // whether this run stamped it.
  const recordSent = async (accepted: SesAcceptance): Promise<boolean> => {
    const marked = await prisma.email.updateMany({
      where: {id: emailId, sentAt: null},
      data: {
        status: EmailStatus.SENT,
        sentAt: accepted.sentAt,
        messageId: accepted.messageId,
        error: null,
        // Stamped here, because the send path is the one place that knows the address
        // SES was actually given -- `recipientEmail` above, which is the override header
        // when one is set and the contact's address otherwise. The send path is also
        // the only moment the answer can still change: an email that was never handed
        // to SES cannot bounce, so a row that never reaches this update has nothing to
        // exclude. Folded into the existing update rather than written separately, so
        // it costs no extra query per send.
        simulated: isMailboxSimulatorAddress(recipientEmail),
      },
    });
    return marked.count > 0;
  };

  // Everything that follows a send this run recorded. Each step is best-effort (see `bestEffort`).
  const afterSent = async (accepted: SesAcceptance): Promise<void> => {
    const campaignId = email.campaignId;
    if (campaignId) {
      await bestEffort(emailId, 'Counting the campaign send', () => CampaignService.countCampaignSent(campaignId));
    }

    // Record usage for billing (pay-per-email)
    // Uses email ID as idempotency key to prevent double-charging on retries
    // Charge 2 emails if attachments are present
    const customer = email.project.customer;
    if (customer) {
      const hasAttachments = email.attachments && Array.isArray(email.attachments) && email.attachments.length > 0;
      const emailCount = hasAttachments ? 2 : 1;
      await bestEffort(emailId, 'Recording usage', () =>
        MeterService.recordEmailSent(customer, emailCount, `email_${emailId}`),
      );
    }

    // Track event (this will trigger workflows)
    await bestEffort(emailId, 'Tracking email.sent', () =>
      EventService.trackEvent(email.projectId, 'email.sent', email.contactId, email.id, {
        subject,
        from: email.from,
        fromName: email.fromName,
        messageId: accepted.messageId,
        emailId: email.id,
        templateId: email.templateId,
        campaignId: email.campaignId,
        sourceType: email.sourceType,
        // When SES accepted it, also when a retry records an earlier acceptance.
        sentAt: accepted.sentAt.toISOString(),
      }),
    );

    if (campaignId) {
      await bestEffort(emailId, 'Finalizing the campaign', () => CampaignService.finalizeIfDone(campaignId));
    }
  };

  // Not stamped means another run already stamped this email -- SES accepted the
  // message, then the job was retried. Everything after the SENT write sends a
  // second signal for one delivery (a duplicate `email.sent` re-triggers workflows),
  // so stop here rather than replaying it. Finalization still runs: this email is
  // terminal either way, and the campaign must not be left stuck in SENDING.
  const alreadyRecorded = async (accepted: SesAcceptance): Promise<void> => {
    signale.warn(
      `[EMAIL-PROCESSOR] Email ${emailId} (SES message ${accepted.messageId}) was already marked sent or no longer exists, skipping duplicate side effects`,
    );

    const campaignId = email.campaignId;
    if (campaignId) {
      await bestEffort(emailId, 'Finalizing the campaign', () => CampaignService.finalizeIfDone(campaignId));
    }
  };

  try {
    // Everything up to building the message runs before the email is claimed, so a failure in it
    // leaves the email PENDING for the next attempt.
    const contactData = (email.contact.data as Record<string, unknown>) || {};
    // An email sent with templating off goes out as it was written, placeholders and all.
    const formattedEmail =
      customHeaders?.[TEMPLATING_HEADER] === 'off'
        ? {subject: email.subject, body: email.body}
        : EmailService.format({
            subject: email.subject,
            body: email.body,
            data: {
              email: email.contact.email,
              ...contactData,
              data: contactData,
              unsubscribeUrl: withSourceEmail(`${DASHBOARD_URI}/unsubscribe/${email.contact.id}`, emailId),
              subscribeUrl: withSourceEmail(`${DASHBOARD_URI}/subscribe/${email.contact.id}`, emailId),
              manageUrl: withSourceEmail(`${DASHBOARD_URI}/manage/${email.contact.id}`, emailId),
            },
          });
    subject = formattedEmail.subject;

    // Classify the email once: it decides both the unsubscribe footer and the
    // standards-based headers below.
    const emailClass = classifyEmail({
      sourceType: email.sourceType,
      templateType: email.template?.type,
      campaignType: email.campaign?.type,
    });

    // Compile HTML with unsubscribe footer and badge.
    // Only marketing emails get the Plunk unsubscribe footer.
    const compiledHtml = EmailService.compile({
      content: formattedEmail.body,
      contact: email.contact,
      project: email.project,
      includeUnsubscribe: emailClass === 'marketing',
      sourceEmailId: emailId,
    });

    // Use fromName from database if available, otherwise fall back to project name
    // The 'from' field in the database is just the email address
    const fromName = email.fromName || email.project.name;
    const fromEmail = email.from;

    // Remove internal headers before sending: every `X-Plunk-*` header on an email is Plunk's own.
    const publicHeaders = customHeaders
      ? Object.fromEntries(Object.entries(customHeaders).filter(([name]) => !isInternalHeader(name)))
      : undefined;

    // Build the outbound headers: standards-based defaults for the email class
    // plus any caller-supplied headers (which override the defaults).
    const outboundHeaders = buildEmailHeaders({
      emailClass,
      isCampaign: email.campaignId != null,
      hasListManagementLink: bodyHasListManagementLink(compiledHtml, email.contact.id),
      unsubscribeId: email.contact.id,
      sourceEmailId: emailId,
      customHeaders: publicHeaders,
    });

    // Build recipient with name if available
    const recipient: {name?: string; email: string} | string = email.toName
      ? {name: email.toName, email: recipientEmail}
      : recipientEmail;

    // Determine tracking based on project settings and email type
    const shouldTrack = EmailService.shouldTrackEmail(email.project.tracking, email.sourceType);

    if (!acceptedBySes) {
      const message = buildRawEmail({
        from: {
          name: fromName,
          email: fromEmail,
        },
        to: typeof recipient === 'string' ? [recipient] : [{name: recipient.name, email: recipient.email}],
        content: {
          subject: formattedEmail.subject,
          html: compiledHtml,
        },
        reply: email.replyTo || undefined,
        headers: outboundHeaders,
        tracking: shouldTrack,
        attachments: email.attachments as {filename: string; content: string; contentType: string}[] | null,
      });

      // Check for phishing/dangerous content before sending
      const phishingCheck = await SecurityService.checkPhishingContent(
        email.projectId,
        email.project.name,
        email.from,
        formattedEmail.subject,
        compiledHtml,
      );

      if (phishingCheck.shouldDisable) {
        // Record this email's failure before disabling the project: disabling fails every PENDING
        // email of the project as "Project is disabled", this one included, and the write below
        // would then find nothing to record. The project is disabled and the job ends even when
        // that write fails, because the check is sampled and a retry would most likely not run it
        // again.
        await markTerminalFailure(
          email,
          EmailStatus.PENDING,
          'This email could not be sent. The project has been disabled. Please contact support.',
          {reason: 'phishing_blocked', attempts: job.attemptsMade + 1},
        ).catch((writeError: unknown) => {
          signale.error(`[EMAIL-PROCESSOR] Failed to record the policy failure of email ${emailId}:`, writeError);
        });

        await SecurityService.disableProjectForPhishing(
          email.projectId,
          formattedEmail.subject,
          phishingCheck.confidence,
          'Phishing content detected',
        );

        throw new UnrecoverableError(`Project ${email.projectId} has been disabled due to a policy violation`);
      }

      // Claim the email right before handing it to SES. The claim is conditional: of two runs of
      // the same email only one sends it, and a campaign email is claimed only while its campaign
      // is still sending, so a cancel that landed since the check above stops it here.
      const claimed = await prisma.email.updateMany({
        where: {
          id: emailId,
          status: EmailStatus.PENDING,
          ...(email.campaignId ? {campaign: {is: {status: CampaignStatus.SENDING}}} : {}),
        },
        data: {status: EmailStatus.SENDING},
      });
      if (claimed.count === 0) {
        const current = await prisma.email.findUnique({
          where: {id: emailId},
          select: {status: true, campaign: {select: {status: true}}},
        });
        if (
          current?.status === EmailStatus.PENDING &&
          current.campaign &&
          current.campaign.status !== CampaignStatus.SENDING
        ) {
          await failForStoppedCampaign(email, current.campaign.status);
          return;
        }
        if (current?.status === EmailStatus.PENDING || current?.status === EmailStatus.SENDING) {
          // Another run of this email holds it: BullMQ ran the job again after it stalled, while its
          // first run was still alive. Look at the email again once that run is over instead of
          // ending the job, which records the outcome should that run fail to.
          throw new HeldByAnotherRun();
        }
        signale.warn(`[EMAIL-PROCESSOR] Email ${emailId} is no longer pending, not sending it`);
        return;
      }

      // Send via AWS SES, then checkpoint acceptance in Redis before any
      // database work. If Postgres is unavailable, the retry can finalize
      // this exact message without submitting it again.
      submitted = true;
      const result = await submitRawEmail(message);
      acceptedBySes = {messageId: result.messageId, sentAt: new Date()};
      acceptanceCheckpointed = await checkpointSesAcceptance(job, acceptedBySes);
    }

    if (!(await recordSent(acceptedBySes))) {
      await alreadyRecorded(acceptedBySes);
      return;
    }

    await afterSent(acceptedBySes);
  } catch (error) {
    if (error instanceof HeldByAnotherRun) {
      signale.warn(`[EMAIL-PROCESSOR] Email ${emailId} is held by another run, looking at it again later`);
      return runAgainLater(job, token, CLAIM_RECHECK_MS);
    }

    signale.error(`[EMAIL-PROCESSOR] Failed to send email ${emailId}:`, error);

    if (acceptedBySes) {
      // SES accepted the message, so no attempt may submit it again. Everything after
      // the SENT write is best-effort, so the write itself is what failed: try it once
      // more.
      let stamped: boolean | undefined;
      try {
        stamped = await recordSent(acceptedBySes);
      } catch (persistenceError) {
        signale.error(
          `[EMAIL-PROCESSOR] Failed to persist accepted SES message ${acceptedBySes.messageId} for email ${emailId}:`,
          persistenceError,
        );
      }

      if (stamped !== undefined) {
        await (stamped ? afterSent(acceptedBySes) : alreadyRecorded(acceptedBySes));
        return;
      }

      if (!acceptanceCheckpointed) {
        acceptanceCheckpointed = await checkpointSesAcceptance(job, acceptedBySes);
      }

      // A checkpointed acceptance waits for the database, and the next run records the known SES
      // message. Without a checkpoint, the retry finds the email SENDING and records its outcome as
      // unknown rather than risk a second send.
      if (acceptanceCheckpointed) {
        return runAgainLater(job, token, recordRetryDelay(acceptedBySes));
      }
      throw error;
    }

    // The policy check records its outcome before it throws.
    if (error instanceof UnrecoverableError) {
      throw error;
    }

    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    // A failure before the message was handed to SES cannot have sent it.
    const failure = submitted ? classifySendFailure(error) : 'retryable';
    const attemptsLeft = job.attemptsMade + 1 < Math.max(1, job.opts.attempts ?? 1);
    // The status this run left the email in: claimed only right before submission. Every write
    // below is conditional on it, so a run that failed before its claim never releases or fails
    // another run's claim.
    const held = submitted ? EmailStatus.SENDING : EmailStatus.PENDING;

    if (failure === 'retryable' && attemptsLeft) {
      // Keep it eligible for the next BullMQ attempt. The worker's entry guard only
      // processes PENDING rows, so writing FAILED now would silently turn the retry
      // into a no-op.
      await prisma.email.updateMany({
        where: {id: emailId, status: held, sentAt: null},
        data: {status: EmailStatus.PENDING, error: errorMessage},
      });
      throw error; // Re-throw to trigger retry
    }

    if (failure === 'retryable') {
      await markTerminalFailure(email, held, errorMessage, {
        reason: 'attempts_exhausted',
        attempts: job.attemptsMade + 1,
      });
      throw error;
    }

    const failureMessage = failure === 'unknown' ? unknownOutcome(errorMessage) : errorMessage;
    await markTerminalFailure(email, held, failureMessage, {
      reason: failure === 'unknown' ? 'ses_outcome_unknown' : 'ses_rejected',
      attempts: job.attemptsMade + 1,
    });
    throw new UnrecoverableError(failureMessage);
  }
}

/**
 * Settle the email of a job that failed for good, where its run did not: a run whose write of the
 * outcome failed as well, and a job BullMQ failed without running it because it stalled too often
 * (its runs crashed the worker, or blocked it past the job's lock). Never rejects.
 */
export async function settleFailedJob(job: Job<SendEmailJobData>, error: Error): Promise<void> {
  try {
    const email = await prisma.email.findUnique({
      where: {id: job.data.emailId},
      select: {
        id: true,
        status: true,
        projectId: true,
        contactId: true,
        campaignId: true,
        templateId: true,
        sourceType: true,
        subject: true,
        from: true,
        fromName: true,
      },
    });
    if (!email || (email.status !== EmailStatus.PENDING && email.status !== EmailStatus.SENDING)) {
      return;
    }

    // SES accepted the message: run the job again, which records it and never sends it twice.
    if (job.data.acceptedBySes) {
      await job.retry('failed');
      return;
    }

    const sending = email.status === EmailStatus.SENDING;
    await markTerminalFailure(email, email.status, sending ? unknownOutcome(error.message) : error.message, {
      reason: sending ? 'stalled_without_checkpoint' : 'attempts_exhausted',
      attempts: job.attemptsMade,
    });
  } catch (settleError) {
    signale.error(`[EMAIL-PROCESSOR] Failed to settle the email of failed job ${job.id}:`, settleError);
  }
}

export async function createEmailWorker() {
  // Fetch the rate limit (from env, AWS, or default)
  const rateLimit = await getEmailRateLimit();
  const concurrency = deriveWorkerConcurrency(rateLimit);
  signale.info(
    `[EMAIL-PROCESSOR] Worker concurrency: ${concurrency} (rate limit: ${rateLimit}/s)`,
  );
  const worker = new Worker<SendEmailJobData>(
    emailQueue.name,
    processEmailJob,
    {
      connection: emailQueue.opts.connection,
      concurrency,
      limiter: {
        max: rateLimit, // Max emails per second (from env, AWS SES quota, or default)
        duration: 1000,
      },
    },
  );

  worker.on('completed', job => {
    signale.info(`[EMAIL-PROCESSOR] Job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    signale.error(`[EMAIL-PROCESSOR] Job ${job?.id} failed:`, err.message);
    // Only a job that failed for good has finished; one that failed an attempt is retried.
    if (job?.finishedOn) {
      void settleFailedJob(job, err);
    }
  });

  worker.on('error', err => {
    signale.error('[EMAIL-PROCESSOR] Worker error:', err);
  });

  return worker;
}
