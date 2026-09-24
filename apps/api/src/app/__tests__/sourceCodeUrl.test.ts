import {getTranslation, loadTranslations, SUPPORTED_LANGUAGES} from '@plunk/shared';
import type {Request, Response} from 'express';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {httpUrlEnv} from '../constants';

/** The body `GET /config` answers with, from a freshly imported controller. */
async function configBody() {
  vi.resetModules();
  const {Config} = await import('../../controllers/Config');
  const json = vi.fn();
  const res = {status: vi.fn(() => ({json}))} as unknown as Response;
  new Config().getConfig({} as Request, res);
  return json.mock.calls[0]?.[0];
}

describe('SOURCE_CODE_URL', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is not shown when unset', async () => {
    vi.stubEnv('SOURCE_CODE_URL', '');

    expect((await configBody()).features.sourceCode).toEqual({url: null});
  });

  it('is exposed to the dashboard and the recipient pages through /config', async () => {
    vi.stubEnv('SOURCE_CODE_URL', 'https://git.example.com/mail/plunk');

    expect((await configBody()).features.sourceCode).toEqual({url: 'https://git.example.com/mail/plunk'});
  });

  it.each(['javascript:alert(1)', 'ftp://example.com/plunk', 'git.example.com/plunk', 'not a url'])(
    'refuses %s, since it ends up in links',
    raw => {
      vi.stubEnv('SOURCE_CODE_URL', raw);

      expect(() => httpUrlEnv('SOURCE_CODE_URL')).toThrow(`SOURCE_CODE_URL must be an http(s) URL, got "${raw}"`);
    },
  );

  it.each(SUPPORTED_LANGUAGES.map(language => language.code))('has a link label in %s', async code => {
    const label = getTranslation(await loadTranslations(code), 'pages.common.sourceCode');

    expect(label).not.toBe('pages.common.sourceCode');
    expect(label.trim()).not.toBe('');
  });
});
