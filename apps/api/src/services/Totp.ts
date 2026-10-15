import {createHmac, randomBytes, timingSafeEqual} from 'node:crypto';

/**
 * Time-based one-time passwords (fork D39), as authenticator apps compute them: RFC 6238 over HMAC-SHA1, six
 * digits, a code every 30 seconds. Secrets travel as base32 (RFC 4648), the form authenticator apps read.
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const PERIOD_SECONDS = 30;
const DIGITS = 6;

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

/** Decodes base32, ignoring case, spaces and padding; throws on any other character. */
export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=]/g, '');
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) {
      throw new Error('Not a base32 secret');
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

/** A new secret: 160 random bits, the size RFC 4226 recommends for HMAC-SHA1. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** The 30-second step a moment falls in. */
export function totpStep(now = Date.now()): number {
  return Math.floor(now / 1000 / PERIOD_SECONDS);
}

/** The code for a step (RFC 4226's HOTP with the step as its counter). */
export function totpCode(key: Buffer, step: number, digits = DIGITS): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac('sha1', key).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 0xf;
  const binary = hmac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/**
 * The step a code belongs to, allowing one step either side for clocks that drift, or null when it matches none.
 * Callers refuse a step that was already used, so a code works once.
 */
export function matchTotp(secret: string, code: string, now = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) {
    return null;
  }
  const key = base32Decode(secret);
  const current = totpStep(now);
  for (const step of [current, current - 1, current + 1]) {
    if (timingSafeEqual(Buffer.from(totpCode(key, step)), Buffer.from(code))) {
      return step;
    }
  }
  return null;
}

/** The `otpauth://` URI an authenticator app scans as a QR code. */
export function otpauthUri(options: {issuer: string; account: string; secret: string}): string {
  const issuer = encodeURIComponent(options.issuer);
  const label = `${issuer}:${encodeURIComponent(options.account)}`;
  return `otpauth://totp/${label}?secret=${options.secret}&issuer=${issuer}&algorithm=SHA1&digits=${DIGITS}&period=${PERIOD_SECONDS}`;
}
