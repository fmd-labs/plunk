/**
 * Email queue job data types
 */

/**
 * Job data for sending a single email
 * Used by: emailQueue worker
 */
export interface SendEmailJobData {
  emailId: string;
  /** SES acceptance persisted in Redis before database finalization. */
  acceptedBySes?: {
    messageId: string;
    sentAt: string;
  };
}

/**
 * Job data for settling emails left without a job to send them or record their outcome
 * Used by: emailStallSweepQueue worker
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface EmailStallSweepJobData {
  // Empty - sweeps every email left PENDING or SENDING without a job
}

/**
 * Job data for recording a Stripe meter event
 * Used by: meterQueue worker
 */
export interface MeterEventJobData {
  customerId: string;
  value: number;
  idempotencyKey?: string;
}
