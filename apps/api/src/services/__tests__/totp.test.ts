import {describe, expect, it} from 'vitest';

import {base32Decode, base32Encode, matchTotp, otpauthUri, totpCode, totpStep} from '../Totp';

/** RFC 6238, Appendix B: the SHA-1 seed and its eight-digit codes. */
const RFC_KEY = Buffer.from('12345678901234567890');
const RFC_VECTORS: [number, string][] = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

/** Authenticator-app codes (D39). */
describe('TOTP', () => {
  it('computes the RFC 6238 test vectors', () => {
    for (const [seconds, code] of RFC_VECTORS) {
      expect(totpCode(RFC_KEY, totpStep(seconds * 1000), 8), String(seconds)).toBe(code);
    }
  });

  it('round-trips base32, ignoring case, spaces and padding', () => {
    const secret = base32Encode(RFC_KEY);
    expect(secret).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode(secret.toLowerCase().replace(/(.{4})/g, '$1 ')).equals(RFC_KEY)).toBe(true);
    expect(() => base32Decode('NOT-BASE32!')).toThrow();
  });

  it('matches the current code and one step either side, nothing further', () => {
    const secret = base32Encode(RFC_KEY);
    const now = 1_700_000_000_000;
    const step = totpStep(now);
    const codeAt = (offset: number) => totpCode(RFC_KEY, step + offset);

    expect(matchTotp(secret, codeAt(0), now)).toBe(step);
    expect(matchTotp(secret, codeAt(-1), now)).toBe(step - 1);
    expect(matchTotp(secret, codeAt(1), now)).toBe(step + 1);
    expect(matchTotp(secret, codeAt(2), now)).toBeNull();
    expect(matchTotp(secret, '12345', now)).toBeNull();
    expect(matchTotp(secret, 'abcdef', now)).toBeNull();
  });

  it('builds the otpauth URI apps scan', () => {
    expect(otpauthUri({issuer: 'Plunk', account: 'a+b@example.com', secret: 'ABC'})).toBe(
      'otpauth://totp/Plunk:a%2Bb%40example.com?secret=ABC&issuer=Plunk&algorithm=SHA1&digits=6&period=30',
    );
  });
});
