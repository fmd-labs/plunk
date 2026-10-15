import type {Passkey} from '@plunk/db';
import {Prisma} from '@plunk/db';
import {SecurityNoticeEmail, sendPlatformEmail} from '@plunk/email';
import type {TwoFactorMethods, TwoFactorSignIn} from '@plunk/types';
import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import * as React from 'react';
import signale from 'signale';

import {DASHBOARD_URI, JWT_SECRET, LANDING_URI, TWO_FACTOR_ENCRYPTION_KEY} from '../app/constants.js';
import {prisma} from '../database/prisma.js';
import {redis} from '../database/redis.js';
import {BadRequest, NotAuthenticated, NotFound, RateLimitError} from '../exceptions/index.js';

import {Keys} from './keys.js';
import {base32Encode, generateTotpSecret, matchTotp, otpauthUri} from './Totp.js';

/** How long a sign-in waits for its second factor, and how long a passkey sign-in's options stay valid. */
const SIGN_IN_TTL_SECONDS = 10 * 60;
/** Second factors one sign-in takes before it has to start over with the password. */
const ATTEMPTS_PER_SIGN_IN = 5;
/** Second factors a user takes across sign-ins within the window, so starting over doesn't reset the count. */
const ATTEMPTS_PER_USER = 10;
const ATTEMPT_WINDOW_SECONDS = 15 * 60;
/** How long an authenticator-app setup and a passkey registration wait. */
const SETUP_TTL_SECONDS = 15 * 60;
const REGISTRATION_TTL_SECONDS = 5 * 60;
const RECOVERY_CODE_COUNT = 10;

const deriveKey = (secret: string, purpose: string) =>
  Buffer.from(hkdfSync('sha256', secret, 'plunk-fork-two-factor', purpose, 32));

/** Keys for authenticator-app secrets: the current one first, then one a secret may still be stored under. */
const SECRET_KEYS = TWO_FACTOR_ENCRYPTION_KEY
  ? [deriveKey(TWO_FACTOR_ENCRYPTION_KEY, 'totp-secret-v1'), deriveKey(JWT_SECRET, 'totp-secret-v1')]
  : [deriveKey(JWT_SECRET, 'totp-secret-v1')];
/** Signs a passkey sign-in's challenge, so the options need no state until the passkey answers. */
const PASSKEY_TOKEN_KEY = deriveKey(JWT_SECRET, 'passkey-sign-in-v1');

/**
 * Counts an attempt and returns the count, starting the window with the first one. One script, so concurrent
 * attempts each get their own number, and no `EXPIRE` option a Redis before 7 lacks.
 */
const COUNT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return count
`;

/** A sign-in waiting for its second factor, after the password or an OAuth provider. */
interface SignIn {
  userId: string;
  webauthnChallenge?: string;
}

export type PasskeySummary = Pick<Passkey, 'id' | 'name' | 'deviceType' | 'backedUp' | 'createdAt' | 'lastUsedAt'>;

/**
 * Two-factor authentication (fork D39): an authenticator app (TOTP), passkeys, and recovery codes. With either
 * factor on, a password or OAuth sign-in only starts a sign-in that the second factor completes; a passkey also
 * signs in on its own, as it proves possession and the user's presence at once.
 */
export class TwoFactorService {
  /** The relying party: the dashboard, where the browser runs every WebAuthn ceremony. */
  public static relyingParty() {
    const url = new URL(DASHBOARD_URI);
    return {rpID: url.hostname, origin: url.origin, rpName: this.instanceName()};
  }

  /** The name apps and passkey prompts show, with the host, so two instances read differently. */
  private static instanceName(): string {
    return `Plunk (${new URL(DASHBOARD_URI).hostname})`;
  }

  // Secrets at rest

  public static encryptSecret(secret: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', SECRET_KEYS[0]!, iv);
    const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return ['v1', iv, cipher.getAuthTag(), encrypted]
      .map(part => (typeof part === 'string' ? part : part.toString('base64url')))
      .join('.');
  }

  /**
   * The secret and whether it is stored under the current key, or null when no key reads it (most likely
   * `JWT_SECRET` changed since it was stored).
   */
  private static readSecret(stored: string): {secret: string; current: boolean} | null {
    const [version, iv, tag, encrypted] = stored.split('.');
    if (version !== 'v1' || !iv || !tag || !encrypted) {
      return null;
    }
    for (const [index, key] of SECRET_KEYS.entries()) {
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
        decipher.setAuthTag(Buffer.from(tag, 'base64url'));
        const secret = Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]);
        return {secret: secret.toString('utf8'), current: index === 0};
      } catch {
        // Not this key.
      }
    }
    return null;
  }

  public static decryptSecret(stored: string): string | null {
    return this.readSecret(stored)?.secret ?? null;
  }

  // State

  /** The factors a user has on. Read from the database: the cached user can be an hour old. */
  public static async methods(userId: string): Promise<TwoFactorMethods> {
    const user = await prisma.user.findUnique({
      where: {id: userId},
      select: {totpEnabledAt: true, _count: {select: {passkeys: true}}},
    });
    return {totp: Boolean(user?.totpEnabledAt), passkey: (user?._count.passkeys ?? 0) > 0};
  }

  public static async isEnabled(userId: string): Promise<boolean> {
    const {totp, passkey} = await this.methods(userId);
    return totp || passkey;
  }

  public static async status(userId: string) {
    const [user, passkeys, recoveryCodesLeft] = await Promise.all([
      prisma.user.findUnique({where: {id: userId}, select: {totpEnabledAt: true}}),
      prisma.passkey.findMany({
        where: {userId},
        select: {id: true, name: true, deviceType: true, backedUp: true, createdAt: true, lastUsedAt: true},
        orderBy: {createdAt: 'asc'},
      }),
      prisma.recoveryCode.count({where: {userId}}),
    ]);
    return {totpEnabledAt: user?.totpEnabledAt ?? null, passkeys, recoveryCodesLeft};
  }

  // Authenticator app

  /** A new secret, held until its first code confirms it, with the URI to scan. */
  public static async startTotp(user: {id: string; email: string}): Promise<{secret: string; uri: string}> {
    const secret = generateTotpSecret();
    await redis.setex(Keys.TwoFactor.totpSetup(user.id), SETUP_TTL_SECONDS, this.encryptSecret(secret));
    return {secret, uri: otpauthUri({issuer: this.instanceName(), account: user.email, secret})};
  }

  /** Turns the app on once a code from the new secret checks out; recovery codes come with a user's first factor. */
  public static async enableTotp(userId: string, code: string): Promise<{recoveryCodes: string[] | null}> {
    const pending = await redis.get(Keys.TwoFactor.totpSetup(userId));
    const secret = pending ? this.decryptSecret(pending) : null;
    if (!secret) {
      throw new BadRequest('The setup expired. Start it again.');
    }
    const step = matchTotp(secret, code.replace(/\s+/g, ''));
    if (step === null || !(await this.claimStep(userId, step))) {
      throw new BadRequest('That code is not right. Check the time on your device and try the newest code.');
    }
    await prisma.user.update({
      where: {id: userId},
      data: {totpSecret: this.encryptSecret(secret), totpEnabledAt: new Date()},
    });
    await Promise.all([redis.del(Keys.TwoFactor.totpSetup(userId)), this.forgetCachedUser(userId)]);
    const recoveryCodes = await this.ensureRecoveryCodes(userId);
    await this.notify(
      userId,
      'An authenticator app was turned on',
      'Signing in to your account now asks for a code from it.',
    );
    return {recoveryCodes};
  }

  public static async disableTotp(userId: string): Promise<void> {
    await prisma.user.update({where: {id: userId}, data: {totpSecret: null, totpEnabledAt: null}});
    await Promise.all([this.dropRecoveryCodesWithoutFactors(userId), this.forgetCachedUser(userId)]);
    await this.notify(userId, 'The authenticator app was turned off', 'Signing in no longer asks for its codes.');
  }

  // Recovery codes

  /** New codes, replacing the old ones; shown once. */
  public static async regenerateRecoveryCodes(userId: string, {notify = true} = {}): Promise<string[]> {
    if (!(await this.isEnabled(userId))) {
      throw new BadRequest('Turn on an authenticator app or add a passkey first');
    }
    const codes = Array.from({length: RECOVERY_CODE_COUNT}, () => {
      const raw = base32Encode(randomBytes(7)).slice(0, 10).toLowerCase();
      return `${raw.slice(0, 5)}-${raw.slice(5)}`;
    });
    await prisma.$transaction([
      prisma.recoveryCode.deleteMany({where: {userId}}),
      prisma.recoveryCode.createMany({
        data: codes.map(code => ({userId, codeHash: this.hashRecoveryCode(userId, code)})),
      }),
    ]);
    if (notify) {
      await this.notify(userId, 'New recovery codes were made', 'Your previous recovery codes no longer work.');
    }
    return codes;
  }

  /** A code's hash, salted with the user, so one pass over a dump can't test every user's codes at once. */
  private static hashRecoveryCode(userId: string, code: string): string {
    return createHash('sha256')
      .update(`${userId}:${code.toLowerCase().replace(/[^a-z0-9]/g, '')}`)
      .digest('hex');
  }

  /** Codes for a user who has none yet, or null when they have some. */
  private static async ensureRecoveryCodes(userId: string): Promise<string[] | null> {
    return (await prisma.recoveryCode.count({where: {userId}})) > 0
      ? null
      : this.regenerateRecoveryCodes(userId, {notify: false});
  }

  /** Recovery codes stand in for a factor, so they go with the last one. */
  private static async dropRecoveryCodesWithoutFactors(userId: string): Promise<void> {
    if (!(await this.isEnabled(userId))) {
      await prisma.recoveryCode.deleteMany({where: {userId}});
    }
  }

  // Codes at sign-in

  /** Whether a code is the user's: a current authenticator code not used before, or an unused recovery code. */
  private static async checkCode(userId: string, input: string): Promise<boolean> {
    const code = input.replace(/\s+/g, '');
    if (/^\d{6}$/.test(code)) {
      const user = await prisma.user.findUnique({where: {id: userId}, select: {totpSecret: true, totpEnabledAt: true}});
      if (!user?.totpEnabledAt || !user.totpSecret) {
        return false;
      }
      const stored = this.readSecret(user.totpSecret);
      if (!stored) {
        signale.warn(
          `[TWO-FACTOR] The authenticator secret of user ${userId} can't be read with the current key; did JWT_SECRET or TWO_FACTOR_ENCRYPTION_KEY change?`,
        );
        return false;
      }
      const step = matchTotp(stored.secret, code);
      if (step === null || !(await this.claimStep(userId, step))) {
        return false;
      }
      // A secret still under an earlier key moves to the current one once it is used.
      if (!stored.current) {
        await prisma.user.update({where: {id: userId}, data: {totpSecret: this.encryptSecret(stored.secret)}});
      }
      return true;
    }
    // A recovery code works once: deleting it is what uses it, so two sign-ins can't both spend it.
    const used = await prisma.recoveryCode.deleteMany({where: {userId, codeHash: this.hashRecoveryCode(userId, code)}});
    if (used.count !== 1) {
      return false;
    }
    const left = await prisma.recoveryCode.count({where: {userId}});
    await this.notify(
      userId,
      'A recovery code was used to sign in',
      `${left === 1 ? '1 recovery code is' : `${left} recovery codes are`} left. Make new ones on your account page when you run low.`,
    );
    return true;
  }

  /** Marks a time step used; false when it already was, so a code seen once can't sign in again. */
  private static async claimStep(userId: string, step: number): Promise<boolean> {
    // Kept past the steps a code is accepted in (the current one and one either side).
    const claimed = await redis.set(Keys.TwoFactor.totpStepUsed(userId, step), '1', 'EX', 120, 'NX');
    return claimed === 'OK';
  }

  // Sign-ins

  /** Starts a sign-in that a second factor completes, or null for a user with no second factor on. */
  public static async startSignInIfEnabled(userId: string): Promise<TwoFactorSignIn | null> {
    const methods = await this.methods(userId);
    if (!methods.totp && !methods.passkey) {
      return null;
    }
    const challenge = randomBytes(32).toString('base64url');
    await redis.setex(Keys.TwoFactor.signIn(challenge), SIGN_IN_TTL_SECONDS, JSON.stringify({userId} satisfies SignIn));
    return {challenge, methods};
  }

  private static async readSignIn(token: string): Promise<SignIn> {
    const stored = token ? await redis.get(Keys.TwoFactor.signIn(token)) : null;
    if (!stored) {
      throw new NotAuthenticated('This sign-in expired. Sign in again.');
    }
    return JSON.parse(stored) as SignIn;
  }

  /** Ends a sign-in, true only for the one caller that ends it, so a token signs in once. */
  private static async consumeSignIn(token: string): Promise<boolean> {
    return (await redis.del(Keys.TwoFactor.signIn(token))) === 1;
  }

  private static async count(key: string, windowSeconds: number): Promise<number> {
    return Number(await redis.eval(COUNT_SCRIPT, 1, key, windowSeconds));
  }

  /**
   * Counts a second-factor attempt against the user and the sign-in before it is checked, and refuses it past
   * either limit. Counting first is what makes the limits hold for attempts sent at the same time.
   */
  private static async reserveAttempt(token: string, userId: string): Promise<{last: boolean}> {
    const [forUser, forSignIn] = await Promise.all([
      this.count(Keys.TwoFactor.attempts(userId), ATTEMPT_WINDOW_SECONDS),
      this.count(Keys.TwoFactor.signInAttempts(token), SIGN_IN_TTL_SECONDS),
    ]);
    if (forUser > ATTEMPTS_PER_USER) {
      await this.consumeSignIn(token);
      if (forUser === ATTEMPTS_PER_USER + 1) {
        signale.warn(`[TWO-FACTOR] Too many second-factor attempts for user ${userId}, refusing for now`);
      }
      throw new RateLimitError('Too many attempts. Wait 15 minutes, then sign in again.');
    }
    if (forSignIn > ATTEMPTS_PER_SIGN_IN) {
      await this.consumeSignIn(token);
      throw new NotAuthenticated('Too many attempts. Sign in again.');
    }
    return {last: forSignIn === ATTEMPTS_PER_SIGN_IN};
  }

  /** Refuses a wrong second factor; the sign-in's last attempt ends it. */
  private static async refuseAttempt(token: string, last: boolean, message: string): Promise<never> {
    if (last) {
      await this.consumeSignIn(token);
      throw new NotAuthenticated(`${message}. Too many attempts: sign in again.`);
    }
    throw new BadRequest(message);
  }

  /** Ends a sign-in that its second factor completed, and clears its counts. */
  private static async finishSignIn(token: string, userId: string): Promise<string> {
    if (!(await this.consumeSignIn(token))) {
      throw new NotAuthenticated('This sign-in expired. Sign in again.');
    }
    await redis.del(Keys.TwoFactor.attempts(userId), Keys.TwoFactor.signInAttempts(token));
    return userId;
  }

  /** Completes a sign-in with an authenticator or recovery code; the user it signs in. */
  public static async completeWithCode(token: string, code: string): Promise<string> {
    const {userId} = await this.readSignIn(token);
    const {last} = await this.reserveAttempt(token, userId);
    if (!(await this.checkCode(userId, code))) {
      return this.refuseAttempt(token, last, 'That code is not right');
    }
    return this.finishSignIn(token, userId);
  }

  // Passkeys

  public static async registrationOptions(user: {id: string; email: string}) {
    const {rpID, rpName} = this.relyingParty();
    const existing = await prisma.passkey.findMany({
      where: {userId: user.id},
      select: {credentialId: true, transports: true},
    });
    const options = await generateRegistrationOptions({
      rpName,
      rpID,
      userName: user.email,
      userID: new TextEncoder().encode(user.id),
      attestationType: 'none',
      excludeCredentials: existing.map(passkey => ({id: passkey.credentialId, transports: passkey.transports})),
      // A discoverable credential, so the passkey can also sign in on its own.
      authenticatorSelection: {residentKey: 'required', userVerification: 'preferred'},
    });
    await redis.setex(Keys.TwoFactor.passkeyRegistration(user.id), REGISTRATION_TTL_SECONDS, options.challenge);
    return options;
  }

  /** Adds the passkey a registration produced; recovery codes come with a user's first factor. */
  public static async register(
    userId: string,
    name: string,
    response: RegistrationResponseJSON,
  ): Promise<{passkey: PasskeySummary; recoveryCodes: string[] | null}> {
    const expectedChallenge = await redis.get(Keys.TwoFactor.passkeyRegistration(userId));
    if (!expectedChallenge) {
      throw new BadRequest('Adding the passkey took too long. Try again.');
    }
    await redis.del(Keys.TwoFactor.passkeyRegistration(userId));
    const {rpID, origin} = this.relyingParty();
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        requireUserVerification: false,
      });
    } catch (error) {
      throw new BadRequest(
        `The passkey could not be verified: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
    if (!verification.verified) {
      throw new BadRequest('The passkey could not be verified');
    }
    const {credential, credentialDeviceType, credentialBackedUp} = verification.registrationInfo;
    let passkey: PasskeySummary;
    try {
      passkey = await prisma.passkey.create({
        data: {
          userId,
          name,
          credentialId: credential.id,
          publicKey: Buffer.from(credential.publicKey),
          counter: BigInt(credential.counter),
          transports: credential.transports ?? [],
          deviceType: credentialDeviceType,
          backedUp: credentialBackedUp,
        },
        select: {id: true, name: true, deviceType: true, backedUp: true, createdAt: true, lastUsedAt: true},
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new BadRequest('This passkey is added already');
      }
      throw error;
    }
    const recoveryCodes = await this.ensureRecoveryCodes(userId);
    await this.notify(userId, 'A passkey was added', `A passkey named “${name}” can now sign in to your account.`);
    return {passkey, recoveryCodes};
  }

  public static async removePasskey(userId: string, passkeyId: string): Promise<void> {
    const passkey = await prisma.passkey.findFirst({where: {id: passkeyId, userId}, select: {name: true}});
    const removed = await prisma.passkey.deleteMany({where: {id: passkeyId, userId}});
    if (!passkey || removed.count === 0) {
      throw new NotFound('Passkey not found');
    }
    await this.dropRecoveryCodesWithoutFactors(userId);
    await this.notify(userId, 'A passkey was removed', `The passkey named “${passkey.name}” no longer signs in.`);
  }

  /** A passkey sign-in's own token: its challenge and expiry, signed, so the options keep no state. */
  private static signPasskeyToken(webauthnChallenge: string): string {
    const payload = Buffer.from(JSON.stringify({c: webauthnChallenge, e: Date.now() + SIGN_IN_TTL_SECONDS * 1000}));
    const signature = createHmac('sha256', PASSKEY_TOKEN_KEY).update(payload).digest();
    return `${payload.toString('base64url')}.${signature.toString('base64url')}`;
  }

  /** The challenge a passkey sign-in's token carries, or null when it isn't one, is forged, or expired. */
  private static readPasskeyToken(token: string): string | null {
    const [payload, signature] = token.split('.');
    if (!payload || !signature) {
      return null;
    }
    const expected = createHmac('sha256', PASSKEY_TOKEN_KEY).update(Buffer.from(payload, 'base64url')).digest();
    const given = Buffer.from(signature, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return null;
    }
    try {
      const {c, e} = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {c: string; e: number};
      return typeof c === 'string' && typeof e === 'number' && e > Date.now() ? c : null;
    } catch {
      return null;
    }
  }

  /**
   * Options to sign in with a passkey: for the sign-in `token` names (the user's own passkeys, after the password),
   * or, without one, for any passkey on this device (a passkey sign-in on its own, which must verify the user).
   */
  public static async authenticationOptions(
    token?: string,
  ): Promise<{challenge: string; options: PublicKeyCredentialRequestOptionsJSON}> {
    const {rpID} = this.relyingParty();
    if (!token) {
      const options = await generateAuthenticationOptions({rpID, userVerification: 'required'});
      return {challenge: this.signPasskeyToken(options.challenge), options};
    }
    const signIn = await this.readSignIn(token);
    const passkeys = await prisma.passkey.findMany({
      where: {userId: signIn.userId},
      select: {credentialId: true, transports: true},
    });
    if (passkeys.length === 0) {
      throw new BadRequest('No passkey is set up for this account');
    }
    const options = await generateAuthenticationOptions({
      rpID,
      allowCredentials: passkeys.map(passkey => ({id: passkey.credentialId, transports: passkey.transports})),
      userVerification: 'preferred',
    });
    await redis.set(
      Keys.TwoFactor.signIn(token),
      JSON.stringify({...signIn, webauthnChallenge: options.challenge} satisfies SignIn),
      'KEEPTTL',
    );
    return {challenge: token, options};
  }

  /** Whether a passkey's answer verifies against a challenge; the counter it reported when it does. */
  private static async verifyPasskey(
    passkey: Passkey,
    response: AuthenticationResponseJSON,
    expectedChallenge: string,
    requireUserVerification: boolean,
  ): Promise<number | null> {
    const {rpID, origin} = this.relyingParty();
    try {
      const verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        credential: {
          id: passkey.credentialId,
          publicKey: new Uint8Array(passkey.publicKey),
          counter: Number(passkey.counter),
          transports: passkey.transports,
        },
        requireUserVerification,
      });
      return verification.verified ? verification.authenticationInfo.newCounter : null;
    } catch {
      return null;
    }
  }

  /** Completes a sign-in with a passkey, after the password or on its own; the user it signs in. */
  public static async completeWithPasskey(token: string, response: AuthenticationResponseJSON): Promise<string> {
    const passkey = await prisma.passkey.findUnique({where: {credentialId: response.id}});

    // On its own: the signed token holds the challenge, and the passkey must have verified the user.
    const ownChallenge = this.readPasskeyToken(token);
    if (ownChallenge) {
      const counter = passkey ? await this.verifyPasskey(passkey, response, ownChallenge, true) : null;
      if (!passkey || counter === null) {
        throw new BadRequest('The passkey did not work');
      }
      const first = await redis.set(
        Keys.TwoFactor.passkeyChallengeUsed(ownChallenge),
        '1',
        'EX',
        SIGN_IN_TTL_SECONDS,
        'NX',
      );
      if (first !== 'OK') {
        throw new NotAuthenticated('This sign-in expired. Sign in again.');
      }
      await this.markUsed(passkey.id, counter);
      return passkey.userId;
    }

    // After the password: only that user's passkeys count, against the sign-in's limits.
    const signIn = await this.readSignIn(token);
    if (!signIn.webauthnChallenge) {
      throw new BadRequest('Ask for the passkey options first');
    }
    const {last} = await this.reserveAttempt(token, signIn.userId);
    const counter =
      passkey && passkey.userId === signIn.userId
        ? await this.verifyPasskey(passkey, response, signIn.webauthnChallenge, false)
        : null;
    if (!passkey || counter === null) {
      return this.refuseAttempt(token, last, 'The passkey did not work');
    }
    await this.finishSignIn(token, signIn.userId);
    await this.markUsed(passkey.id, counter);
    return signIn.userId;
  }

  private static async markUsed(passkeyId: string, counter: number): Promise<void> {
    await prisma.passkey.update({where: {id: passkeyId}, data: {counter: BigInt(counter), lastUsedAt: new Date()}});
  }

  /**
   * Tells the user a change to their sign-in happened, by platform email where it is set up, so a change they didn't
   * make doesn't go unnoticed. Never fails the change.
   */
  private static async notify(userId: string, title: string, message: string): Promise<void> {
    try {
      const user = await prisma.user.findUnique({where: {id: userId}, select: {email: true}});
      if (user) {
        await sendPlatformEmail(
          user.email,
          title,
          React.createElement(SecurityNoticeEmail, {
            title,
            message,
            accountUrl: `${DASHBOARD_URI}/account`,
            landingUrl: LANDING_URI,
          }),
        );
      }
    } catch (error) {
      signale.warn(`[TWO-FACTOR] Couldn't send the security notice to user ${userId}:`, error);
    }
  }

  /** The cached user holds the row as it was; drop it after a change, as password changes do. */
  private static async forgetCachedUser(userId: string): Promise<void> {
    await redis.del(Keys.User.id(userId));
  }
}
