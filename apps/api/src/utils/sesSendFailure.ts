/**
 * What a failed SES submission means for the message: whether SES may have accepted it, and so
 * whether another attempt is safe.
 */

/**
 * Start of the error recorded for an email whose SES outcome is unknown: submitting it failed in a
 * way that leaves open whether SES accepted it. Such an email is not sent again, and cancelling its
 * campaign counts it as possibly sent.
 */
export const SES_OUTCOME_UNKNOWN = 'SES outcome unknown';

/**
 * How a failed submission ended, as far as sending the message again goes:
 *
 * - `retryable`: SES did not accept the message, and a later attempt may succeed.
 * - `rejected`: SES refused the message; another attempt would be refused too.
 * - `unknown`: nothing tells whether SES accepted it, so another attempt could deliver it twice.
 */
export type SendFailure = 'retryable' | 'rejected' | 'unknown';

// Error codes of SES answers that refuse only this attempt: throttling, and a request whose
// signature was dated too far from the server's clock (every attempt is signed afresh).
const RETRYABLE_ERROR_NAMES = new Set([
  'Throttling',
  'ThrottlingException',
  'ThrottledException',
  'TooManyRequestsException',
  'RequestThrottled',
  'RequestThrottledException',
  'RequestLimitExceeded',
  'RequestExpired',
  'RequestInTheFuture',
  'RequestTimeTooSkewed',
]);

// Node's error codes for failing to reach the server at all: no connection, so nothing was sent.
const CONNECT_ERROR_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH']);

/**
 * Classify the error of a failed single-attempt SES submission (see {@link SendFailure}).
 *
 * The submission must have been made without the SDK's own retries: an error that follows several
 * attempts says nothing about what the earlier ones did.
 */
export function classifySendFailure(error: unknown): SendFailure {
  const {name, $metadata, $retryable} = (error ?? {}) as {
    name?: string;
    $metadata?: {httpStatusCode?: number};
    $retryable?: {throttling?: boolean};
  };
  const status = $metadata?.httpStatusCode;

  if (status !== undefined) {
    // SES answered. A failure that still carries a success status (an answer that could not be
    // read) may hide an acceptance.
    if (status < 300) {
      return 'unknown';
    }
    if (
      status === 429 ||
      status >= 500 ||
      $retryable?.throttling === true ||
      (name !== undefined && RETRYABLE_ERROR_NAMES.has(name))
    ) {
      return 'retryable';
    }
    return 'rejected';
  }

  // No answer. Only a failure to connect proves the request never left; the connection error may
  // be wrapped as the `cause` of another.
  let current: unknown = error;
  for (let depth = 0; current instanceof Error && depth < 5; depth++) {
    const {code} = current as {code?: string};
    // The SDK's connection timeout fires before a socket connects; it carries no code, only this message.
    const connectionTimedOut =
      current.name === 'TimeoutError' && /did not establish a connection/.test(current.message);
    if ((code !== undefined && CONNECT_ERROR_CODES.has(code)) || connectionTimedOut) {
      return 'retryable';
    }
    current = current.cause;
  }
  return 'unknown';
}
