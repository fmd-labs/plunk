import {SES} from '@aws-sdk/client-ses';
import {beforeAll, describe, expect, it, vi} from 'vitest';

import '../SESService';

vi.mock('@aws-sdk/client-ses', () => {
  const SESMock = vi.fn();
  SESMock.prototype.sendRawEmail = vi.fn();
  return {SES: SESMock};
});

describe('SES clients', () => {
  let configs: unknown[];

  beforeAll(() => {
    // The clients are created when the module loads; read their configuration before the reset
    // after each test clears the recorded calls.
    configs = vi.mocked(SES).mock.calls.map(([config]) => config);
  });

  it('submits messages in a single attempt, with timeouts', () => {
    expect(configs).toContainEqual(
      expect.objectContaining({
        maxAttempts: 1,
        requestHandler: {connectionTimeout: 5_000, requestTimeout: 30_000, throwOnRequestTimeout: true},
      }),
    );
  });

  it('keeps the SDK retries for every other call', () => {
    expect(configs).toHaveLength(2);
    expect(configs).toContainEqual(expect.not.objectContaining({maxAttempts: expect.anything()}));
  });
});
