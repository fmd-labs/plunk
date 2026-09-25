import {describe, expect, it} from 'vitest';

import {classifySendFailure} from '../sesSendFailure';

// Failures as the AWS SDK raises them: an SES answer, and a transport error without one.
function answer(name: string, httpStatusCode: number, extra: object = {}) {
  return Object.assign(new Error(name), {name, $metadata: {httpStatusCode}, ...extra});
}

function transport(code: string, name = 'Error') {
  return Object.assign(new Error(`${code} while sending`), {code, name});
}

describe('classifySendFailure', () => {
  it.each([
    ['throttling, answered with HTTP 400', answer('Throttling', 400)],
    ['HTTP 429', answer('TooManyRequestsException', 429)],
    ['HTTP 500', answer('InternalFailure', 500)],
    ['HTTP 503', answer('ServiceUnavailable', 503)],
    ['a throttling trait', answer('SomethingElse', 400, {$retryable: {throttling: true}})],
    ['an expired signature', answer('RequestExpired', 400)],
    [
      'a signature refused over a clock the SDK then corrected',
      answer('SignatureDoesNotMatch', 403, {$metadata: {httpStatusCode: 403, clockSkewCorrected: true}}),
    ],
  ])('retries what SES refused for this attempt only: %s', (_, error) => {
    expect(classifySendFailure(error)).toBe('retryable');
  });

  it.each([
    ['a rejected message', answer('MessageRejected', 400)],
    ['an unverified MAIL FROM domain', answer('MailFromDomainNotVerifiedException', 400)],
    ['a paused account', answer('AccountSendingPausedException', 400)],
    ['a wrong signature', answer('SignatureDoesNotMatch', 403)],
  ])('does not retry what SES rejected: %s', (_, error) => {
    expect(classifySendFailure(error)).toBe('rejected');
  });

  it.each([
    ['a failed DNS lookup', transport('ENOTFOUND')],
    ['a temporary DNS failure', transport('EAI_AGAIN')],
    ['a refused connection', transport('ECONNREFUSED')],
    ['an unreachable host', transport('EHOSTUNREACH')],
    ['an unreachable network', transport('ENETUNREACH')],
    [
      'the connection timeout',
      Object.assign(
        new Error(
          '@smithy/node-http-handler - the request socket did not establish a connection with the server within the configured timeout of 5000 ms.',
        ),
        {name: 'TimeoutError'},
      ),
    ],
    ['a connection failure wrapped in another error', new Error('send failed', {cause: transport('ECONNREFUSED')})],
    [
      'every address of the host refusing the connection',
      new AggregateError([transport('ECONNREFUSED'), transport('ENETUNREACH')], 'connect failed'),
    ],
    ['a certificate for another host', transport('ERR_TLS_CERT_ALTNAME_INVALID')],
    ['an expired certificate', transport('CERT_HAS_EXPIRED')],
    ['a certificate that cannot be verified', transport('UNABLE_TO_VERIFY_LEAF_SIGNATURE')],
  ])('retries when nothing reached SES: %s', (_, error) => {
    expect(classifySendFailure(error)).toBe('retryable');
  });

  it.each([
    ['a reset connection', transport('ECONNRESET', 'TimeoutError')],
    ['a broken pipe', transport('EPIPE', 'TimeoutError')],
    [
      'the request timeout',
      Object.assign(new Error('a request has exceeded the configured 30000 ms requestTimeout.'), {
        name: 'TimeoutError',
        code: 'ETIMEDOUT',
      }),
    ],
    ['an answer without a message ID', new Error('Could not send email')],
    [
      'one address of the host resetting the connection',
      new AggregateError([transport('ECONNREFUSED'), transport('ECONNRESET')], 'connect failed'),
    ],
    ['a TLS error that can end a connection mid-request', transport('ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC')],
    ['a success answer that could not be read', answer('SyntaxError', 200)],
    ['a thrown value that is not an error', 'boom'],
    ['no error at all', undefined],
  ])('treats the outcome as unknown after %s', (_, error) => {
    expect(classifySendFailure(error)).toBe('unknown');
  });
});
