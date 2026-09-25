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

// Certificate checks, which fail the TLS handshake, before a request is written: the host name, and
// OpenSSL's verification of the chain. Other TLS errors can also end a connection mid-request.
const CERTIFICATE_ERROR_CODE =
  /^(ERR_TLS_CERT_ALTNAME_INVALID|CERT_\w+|UNABLE_TO_\w+|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN)$/;

/**
 * Whether an error proves that the request never reached the server: a connection that was never
 * made. It may be wrapped as the `cause` of another error, or be one of the errors of an
 * `AggregateError`, with which Node fails a connection when every address of the host failed.
 */
function neverConnected(error: unknown, depth = 0): boolean {
  if (!(error instanceof Error) || depth >= 5) {
    return false;
  }
  const {code, syscall} = error as {code?: string; syscall?: string};
  // The SDK's connection timeout fires before a socket connects; it carries no code, only this
  // message. Node's own, for one address of a host, is an ETIMEDOUT of the connect call.
  const connectionTimedOut =
    (error.name === 'TimeoutError' && /did not establish a connection/.test(error.message)) ||
    (code === 'ETIMEDOUT' && syscall === 'connect');
  if (
    (code !== undefined && (CONNECT_ERROR_CODES.has(code) || CERTIFICATE_ERROR_CODE.test(code))) ||
    connectionTimedOut
  ) {
    return true;
  }
  if (
    error instanceof AggregateError &&
    error.errors.length > 0 &&
    error.errors.every(attempt => neverConnected(attempt, depth + 1))
  ) {
    return true;
  }
  return neverConnected(error.cause, depth + 1);
}

/**
 * Classify the error of a failed single-attempt SES submission (see {@link SendFailure}).
 *
 * The submission must have been made without the SDK's own retries: an error that follows several
 * attempts says nothing about what the earlier ones did.
 */
export function classifySendFailure(error: unknown): SendFailure {
  const {name, message, $metadata, $retryable} = (error ?? {}) as {
    name?: string;
    message?: string;
    $metadata?: {httpStatusCode?: number; clockSkewCorrected?: boolean};
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
      (name !== undefined && RETRYABLE_ERROR_NAMES.has(name)) ||
      // A signature dated too far from SES's clock: SES answers `SignatureDoesNotMatch`, saying so.
      // The SDK corrects its clock on the first such answer, which it flags; the other requests
      // already on their way come back unflagged.
      $metadata?.clockSkewCorrected === true ||
      (name === 'SignatureDoesNotMatch' && /Signature (expired|not yet current)/i.test(message ?? ''))
    ) {
      return 'retryable';
    }
    return 'rejected';
  }

  // No answer. Only a failure to connect proves the request never left.
  return neverConnected(error) ? 'retryable' : 'unknown';
}
