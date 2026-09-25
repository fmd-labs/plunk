import {afterEach, describe, expect, it, vi} from 'vitest';

import {booleanEnv} from '../constants';

describe('stalled email sweep settings', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('runs the sweep, and sends nothing a day old or older, by default', async () => {
    vi.resetModules();

    const constants = await import('../constants');

    expect(constants.EMAIL_STALL_SWEEP_ENABLED).toBe(true);
    expect(constants.EMAIL_STALL_SWEEP_MAX_AGE_HOURS).toBe(24);
  });

  it('reads both from the environment', async () => {
    vi.stubEnv('EMAIL_STALL_SWEEP_ENABLED', 'false');
    vi.stubEnv('EMAIL_STALL_SWEEP_MAX_AGE_HOURS', '72');
    vi.resetModules();

    const constants = await import('../constants');

    expect(constants.EMAIL_STALL_SWEEP_ENABLED).toBe(false);
    expect(constants.EMAIL_STALL_SWEEP_MAX_AGE_HOURS).toBe(72);
  });

  it.each(['0', '8761', '1.5', 'a day'])('refuses EMAIL_STALL_SWEEP_MAX_AGE_HOURS=%s at startup', async raw => {
    vi.stubEnv('EMAIL_STALL_SWEEP_MAX_AGE_HOURS', raw);
    vi.resetModules();

    await expect(import('../constants')).rejects.toThrow(
      `EMAIL_STALL_SWEEP_MAX_AGE_HOURS must be a whole number from 1 to 8760, got "${raw}"`,
    );
  });

  it.each(['no', 'False', '0', 'off'])('refuses EMAIL_STALL_SWEEP_ENABLED=%s at startup', async raw => {
    vi.stubEnv('EMAIL_STALL_SWEEP_ENABLED', raw);
    vi.resetModules();

    await expect(import('../constants')).rejects.toThrow(`EMAIL_STALL_SWEEP_ENABLED must be true or false, got "${raw}"`);
  });

  it('takes the default for an empty switch, as for every variable', () => {
    vi.stubEnv('EMAIL_STALL_SWEEP_ENABLED', '');

    expect(booleanEnv('EMAIL_STALL_SWEEP_ENABLED', true)).toBe(true);
  });
});
