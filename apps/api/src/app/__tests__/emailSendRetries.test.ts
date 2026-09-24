import {randomUUID} from 'node:crypto';

import {EmailSourceType} from '@plunk/db';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {QueueService} from '../../services/QueueService';
import {integerEnv} from '../constants';

describe('email send retries', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('queues emails with three attempts by default, the first retry two seconds after the failure', async () => {
    const job = await QueueService.queueEmail(randomUUID(), EmailSourceType.TRANSACTIONAL);

    try {
      expect(job.opts).toMatchObject({attempts: 3, backoff: {type: 'exponential', delay: 2000}});
    } finally {
      await job.remove();
    }
  });

  it('queues emails with the attempts and the backoff from the environment', async () => {
    vi.stubEnv('EMAIL_SEND_ATTEMPTS', '6');
    vi.stubEnv('EMAIL_SEND_BACKOFF_MS', '5000');
    vi.resetModules();

    const queues = await import('../../services/QueueService');

    try {
      const job = await queues.QueueService.queueEmail(randomUUID(), EmailSourceType.TRANSACTIONAL);
      await job.remove();

      expect(job.opts).toMatchObject({attempts: 6, backoff: {type: 'exponential', delay: 5000}});
    } finally {
      // The fresh module opened a connection for each of its queues.
      await Promise.all(
        Object.values(queues)
          .filter((value): value is typeof queues.emailQueue => value instanceof Object && 'defaultJobOptions' in value)
          .map(queue => queue.close()),
      );
    }
  });

  it.each([
    ['EMAIL_SEND_ATTEMPTS', '0', 'from 1 to 10'],
    ['EMAIL_SEND_ATTEMPTS', '11', 'from 1 to 10'],
    ['EMAIL_SEND_ATTEMPTS', '2.5', 'from 1 to 10'],
    ['EMAIL_SEND_ATTEMPTS', 'six', 'from 1 to 10'],
    ['EMAIL_SEND_BACKOFF_MS', '-1', 'from 0 to 60000'],
    ['EMAIL_SEND_BACKOFF_MS', '60001', 'from 0 to 60000'],
  ])('refuses %s=%s at startup', async (key, raw, range) => {
    vi.stubEnv(key, raw);
    vi.resetModules();

    await expect(import('../constants')).rejects.toThrow(`${key} must be a whole number ${range}, got "${raw}"`);
  });

  it.each([
    ['EMAIL_SEND_ATTEMPTS', '10'],
    ['EMAIL_SEND_BACKOFF_MS', '60000'],
  ])('accepts %s=%s at startup', async (key, raw) => {
    vi.stubEnv(key, raw);
    vi.resetModules();

    const constants = await import('../constants');

    expect(constants[key as 'EMAIL_SEND_ATTEMPTS' | 'EMAIL_SEND_BACKOFF_MS']).toBe(Number(raw));
  });

  it('accepts a backoff of zero', () => {
    vi.stubEnv('EMAIL_SEND_BACKOFF_MS', '0');

    expect(integerEnv('EMAIL_SEND_BACKOFF_MS', 2000, 0, 60_000)).toBe(0);
  });

  it('names only the minimum when there is no maximum', () => {
    vi.stubEnv('EMAIL_SEND_ATTEMPTS', '0');

    expect(() => integerEnv('EMAIL_SEND_ATTEMPTS', 3, 1)).toThrow(
      'EMAIL_SEND_ATTEMPTS must be a whole number of at least 1, got "0"',
    );
  });
});
