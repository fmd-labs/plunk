import {afterEach, describe, expect, it, vi} from 'vitest';

import {emailQueue} from '../../services/QueueService';
import {EMAIL_SEND_ATTEMPTS, EMAIL_SEND_BACKOFF_MS, integerEnv} from '../constants';

describe('email send retries', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to three attempts, the first retry two seconds after the failure', () => {
    expect(EMAIL_SEND_ATTEMPTS).toBe(3);
    expect(EMAIL_SEND_BACKOFF_MS).toBe(2000);
    expect(emailQueue.defaultJobOptions).toMatchObject({attempts: 3, backoff: {type: 'exponential', delay: 2000}});
  });

  it('reads the attempts and the backoff from the environment', async () => {
    vi.stubEnv('EMAIL_SEND_ATTEMPTS', '6');
    vi.stubEnv('EMAIL_SEND_BACKOFF_MS', '5000');
    vi.resetModules();

    const constants = await import('../constants');

    expect(constants.EMAIL_SEND_ATTEMPTS).toBe(6);
    expect(constants.EMAIL_SEND_BACKOFF_MS).toBe(5000);
  });

  it.each(['0', '-1', '2.5', 'six', '6 attempts'])('refuses EMAIL_SEND_ATTEMPTS=%s', raw => {
    vi.stubEnv('EMAIL_SEND_ATTEMPTS', raw);

    expect(() => integerEnv('EMAIL_SEND_ATTEMPTS', 3, 1)).toThrow(
      `EMAIL_SEND_ATTEMPTS must be a whole number of at least 1, got "${raw}"`,
    );
  });

  it('accepts a backoff of zero', () => {
    vi.stubEnv('EMAIL_SEND_BACKOFF_MS', '0');

    expect(integerEnv('EMAIL_SEND_BACKOFF_MS', 2000, 0)).toBe(0);
  });
});
