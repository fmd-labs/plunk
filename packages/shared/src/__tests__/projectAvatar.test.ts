import {describe, expect, it} from 'vitest';

import {ProjectSchemas} from '../schemas/index.js';

const avatarOf = (avatarUrl: unknown) => ProjectSchemas.update.safeParse({avatarUrl});

/** A project's avatar URL (D38). */
describe('project avatar URL', () => {
  it('takes an http(s) URL, trimmed', () => {
    expect(avatarOf(' https://cdn.example.com/logo.png ').data?.avatarUrl).toBe('https://cdn.example.com/logo.png');
    expect(avatarOf('http://localhost:9000/plunk/logo.png').data?.avatarUrl).toBe('http://localhost:9000/plunk/logo.png');
  });

  it('removes the avatar for an empty value or null, and leaves it alone when left out', () => {
    expect(avatarOf('').data?.avatarUrl).toBeNull();
    expect(avatarOf(null).data?.avatarUrl).toBeNull();
    expect(ProjectSchemas.update.parse({}).avatarUrl).toBeUndefined();
  });

  it('refuses anything but an absolute http(s) URL', () => {
    for (const value of ['javascript:alert(1)', 'data:image/png;base64,AAAA', '/logo.png', 'logo.png', 'ftp://x/y']) {
      expect(avatarOf(value).success, value).toBe(false);
    }
    expect(avatarOf(`https://example.com/${'a'.repeat(2048)}`).success).toBe(false);
  });
});
