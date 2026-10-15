import type {Passkey} from '@plunk/db';
import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import {createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes} from 'node:crypto';
import signale from 'signale';

import {DASHBOARD_URI, JWT_SECRET} from '../app/constants.js';
import {prisma} from '../database/prisma.js';
import {redis} from '../database/redis.js';
import {BadRequest, NotAuthenticated, NotFound, RateLimitError} from '../exceptions/index.js';

import {Keys} from './keys.js';
import {base32Encode, generateTotpSecret, matchTotp, otpauthUri} from './Totp.js';

/** How long a sign-in waits for its second factor. */
const SIGN_IN_TTL_SECONDS = 10 * 60;
/** Wrong codes one sign-in takes before it has to start over with the password. */
const ATTEMPTS_PER_SIGN_IN = 5;
/** Wrong second factors a user takes across sign-ins within the window, so starting over doesn't reset the count. */
const FAILURES_PER_USER = 10;
const FAILURE_WINDOW_SECONDS = 15 * 60;
/** How long an authenticator-app setup and a passkey registration wait. */
const SETUP_TTL_SECONDS = 15 * 60;
const REGISTRATION_TTL_SECONDS = 5 * 60;
const RECOVERY_CODE_COUNT = 10;

/** The authenticator-app secret's key: derived from `JWT_SECRET`, so a self-host needs no new setting. */
const SECRET_KEY = Buffer.from(hkdfSync('sha256', JWT_SECRET, 'plunk-fork-two-factor', 'totp-secret-v1', 32));

/** A sign-in waiting for its second factor, or a passkey sign-in (no user until the passkey says who). */
interface SignIn {
  userId: string | null;
  attempts: number;
  webauthnChallenge?: string;
}

export interface TwoFactorMethods {
  totp: boolean;
  passkey: boolean;
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
    return {rpID: url.hostname, origin: url.origin, rpName: 'Plunk'};
  }

  // Secrets at rest

  public static encryptSecret(secret: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', SECRET_KEY, iv);
    const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return ['v1', iv, cipher.getAuthTag(), encrypted]
      .map(part => (typeof part === 'string' ? part : part.toString('base64url')))
      .join('.');
  }

  /** The secret, or null when it can't be read (most likely `JWT_SECRET` changed since it was stored). */
  public static decryptSecret(stored: string): string | null {
    try {
      const [version, iv, tag, encrypted] = stored.split('.');
      if (version !== 'v1' || !iv || !tag || !encrypted) {
        return null;
      }
      const decipher = createDecipheriv('aes-256-gcm', SECRET_KEY, Buffer.from(iv, 'base64url'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]).toString('utf8');
    } catch {
      return null;
    }
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
    return {secret, uri: otpauthUri({issuer: 'Plunk', account: user.email, secret})};
  }

  /** Turns the app on once a code from the new secret checks out; recovery codes come with a user's first factor. */
  public static async enableTotp(userId: string, code: string): Promise<{recoveryCodes: string[] | null}> {
    const pending = await redis.get(Keys.TwoFactor.totpSetup(userId));
    const secret = pending ? this.decryptSecret(pending) : null;
    if (!secret) {
      throw new BadRequest('The setup expired. Start it again.');
    }
    const step = matchTotp(secret, code.trim());
    if (step === null || !(await this.claimStep(userId, step))) {
      throw new BadRequest('That code is not right. Check the time on your device and try the newest code.');
    }
    await prisma.user.update({
      where: {id: userId},
      data: {totpSecret: this.encryptSecret(secret), totpEnabledAt: new Date()},
    });
    await Promise.all([redis.del(Keys.TwoFactor.totpSetup(userId)), this.forgetCachedUser(userId)]);
    return {recoveryCodes: await this.ensureRecoveryCodes(userId)};
  }

  public static async disableTotp(userId: string): Promise<void> {
    await prisma.user.update({where: {id: userId}, data: {totpSecret: null, totpEnabledAt: null}});
    await Promise.all([this.dropRecoveryCodesWithoutFactors(userId), this.forgetCachedUser(userId)]);
  }

  // Recovery codes

  /** New codes, replacing the old ones; shown once. */
  public static async regenerateRecoveryCodes(userId: string): Promise<string[]> {
    if (!(await this.isEnabled(userId))) {
      throw new BadRequest('Turn on an authenticator app or add a passkey first');
    }
    const codes = Array.from({length: RECOVERY_CODE_COUNT}, () => {
      const raw = base32Encode(randomBytes(7)).slice(0, 10).toLowerCase();
      return `${raw.slice(0, 5)}-${raw.slice(5)}`;
    });
    await prisma.$transaction([
      prisma.recoveryCode.deleteMany({where: {userId}}),
      prisma.recoveryCode.createMany({data: codes.map(code => ({userId, codeHash: this.hashRecoveryCode(code)}))}),
    ]);
    return codes;
  }

  private static hashRecoveryCode(code: string): string {
    return createHash('sha256')
      .update(code.toLowerCase().replace(/[^a-z0-9]/g, ''))
      .digest('hex');
  }

  /** Codes for a user who has none yet, or null when they have some. */
  private static async ensureRecoveryCodes(userId: string): Promise<string[] | null> {
    return (await prisma.recoveryCode.count({where: {userId}})) > 0 ? null : this.regenerateRecoveryCodes(userId);
  }

  /** Recovery codes stand in for a factor, so they go with the last one. */
  private static async dropRecoveryCodesWithoutFactors(userId: string): Promise<void> {
    if (!(await this.isEnabled(userId))) {
      await prisma.recoveryCode.deleteMany({where: {userId}});
    }
  }

  // Codes at sign-in

  /** Whether a code is the user's: a current authenticator code not used before, or an unused recovery code. */
  private static async checkCode(userId: string, code: string): Promise<boolean> {
    const trimmed = code.trim();
    if (/^\d{6}$/.test(trimmed)) {
      const user = await prisma.user.findUnique({where: {id: userId}, select: {totpSecret: true, totpEnabledAt: true}});
      const secret = user?.totpEnabledAt && user.totpSecret ? this.decryptSecret(user.totpSecret) : null;
      if (!secret) {
        return false;
      }
      const step = matchTotp(secret, trimmed);
      return step !== null && this.claimStep(userId, step);
    }
    // A recovery code works once: deleting it is what uses it, so two sign-ins can't both spend it.
    const used = await prisma.recoveryCode.deleteMany({where: {userId, codeHash: this.hashRecoveryCode(trimmed)}});
    return used.count === 1;
  }

  /** Marks a time step used; false when it already was, so a code seen once can't sign in again. */
  private static async claimStep(userId: string, step: number): Promise<boolean> {
    // Kept past the steps a code is accepted in (the current one and one either side).
    const claimed = await redis.set(Keys.TwoFactor.totpStepUsed(userId, step), '1', 'EX', 120, 'NX');
    return claimed === 'OK';
  }

  // Sign-ins

  /** Starts a sign-in that a second factor completes, after the password or an OAuth provider. */
  public static async startSignIn(userId: string): Promise<{challenge: string; methods: TwoFactorMethods}> {
    const challenge = randomBytes(32).toString('base64url');
    await this.saveSignIn(challenge, {userId, attempts: 0});
    return {challenge, methods: await this.methods(userId)};
  }

  private static async saveSignIn(token: string, signIn: SignIn, keepTtl = false): Promise<void> {
    const value = JSON.stringify(signIn);
    if (keepTtl) {
      await redis.set(Keys.TwoFactor.signIn(token), value, 'KEEPTTL');
    } else {
      await redis.setex(Keys.TwoFactor.signIn(token), SIGN_IN_TTL_SECONDS, value);
    }
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

  /** Counts a wrong second factor against the sign-in and the user; refuses further tries past either limit. */
  private static async recordFailure(token: string, signIn: SignIn): Promise<never> {
    if (signIn.userId) {
      const key = Keys.TwoFactor.failures(signIn.userId);
      const [[, failures]] = (await redis.multi().incr(key).expire(key, FAILURE_WINDOW_SECONDS, 'NX').exec()) as [
        [Error | null, number],
      ];
      if (failures >= FAILURES_PER_USER) {
        await this.consumeSignIn(token);
        signale.warn(`[TWO-FACTOR] ${failures} wrong second factors for user ${signIn.userId}, refusing for now`);
        throw new RateLimitError('Too many wrong codes. Wait 15 minutes, then sign in again.');
      }
    }
    if (signIn.attempts + 1 >= ATTEMPTS_PER_SIGN_IN) {
      await this.consumeSignIn(token);
      throw new NotAuthenticated('Too many wrong codes. Sign in again.');
    }
    await this.saveSignIn(token, {...signIn, attempts: signIn.attempts + 1}, true);
    throw new BadRequest('That code is not right');
  }

  private static async assertNotLockedOut(userId: string): Promise<void> {
    const failures = Number(await redis.get(Keys.TwoFactor.failures(userId)));
    if (failures >= FAILURES_PER_USER) {
      throw new RateLimitError('Too many wrong codes. Wait 15 minutes, then sign in again.');
    }
  }

  /** Completes a sign-in with an authenticator or recovery code; the user it signs in. */
  public static async completeWithCode(token: string, code: string): Promise<string> {
    const signIn = await this.readSignIn(token);
    if (!signIn.userId) {
      throw new NotAuthenticated('This sign-in expired. Sign in again.');
    }
    await this.assertNotLockedOut(signIn.userId);
    if (!(await this.checkCode(signIn.userId, code))) {
      return this.recordFailure(token, signIn);
    }
    if (!(await this.consumeSignIn(token))) {
      throw new NotAuthenticated('This sign-in expired. Sign in again.');
    }
    await redis.del(Keys.TwoFactor.failures(signIn.userId));
    return signIn.userId;
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
    const passkey = await prisma.passkey.create({
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
    return {passkey, recoveryCodes: await this.ensureRecoveryCodes(userId)};
  }

  public static async removePasskey(userId: string, passkeyId: string): Promise<void> {
    const removed = await prisma.passkey.deleteMany({where: {id: passkeyId, userId}});
    if (removed.count === 0) {
      throw new NotFound('Passkey not found');
    }
    await this.dropRecoveryCodesWithoutFactors(userId);
  }

  /**
   * Options to sign in with a passkey: for the sign-in `token` names (the user's own passkeys, after the password),
   * or, without one, for any passkey on this device (a passkey sign-in on its own, which must verify the user).
   */
  public static async authenticationOptions(
    token?: string,
  ): Promise<{challenge: string; options: PublicKeyCredentialRequestOptionsJSON}> {
    const {rpID} = this.relyingParty();
    if (token) {
      const signIn = await this.readSignIn(token);
      if (!signIn.userId) {
        throw new NotAuthenticated('This sign-in expired. Sign in again.');
      }
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
      await this.saveSignIn(token, {...signIn, webauthnChallenge: options.challenge}, true);
      return {challenge: token, options};
    }
    const options = await generateAuthenticationOptions({rpID, userVerification: 'required'});
    const challenge = randomBytes(32).toString('base64url');
    await this.saveSignIn(challenge, {userId: null, attempts: 0, webauthnChallenge: options.challenge});
    return {challenge, options};
  }

  /** Completes a sign-in with a passkey; the user it signs in. */
  public static async completeWithPasskey(token: string, response: AuthenticationResponseJSON): Promise<string> {
    const signIn = await this.readSignIn(token);
    if (!signIn.webauthnChallenge) {
      throw new BadRequest('Ask for the passkey options first');
    }
    if (signIn.userId) {
      await this.assertNotLockedOut(signIn.userId);
    }
    const passkey = await prisma.passkey.findUnique({where: {credentialId: response.id}});
    // After a password, only that user's passkeys count.
    if (!passkey || (signIn.userId && passkey.userId !== signIn.userId)) {
      return this.recordFailure(token, signIn);
    }
    const {rpID, origin} = this.relyingParty();
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: signIn.webauthnChallenge,
        expectedOrigin: origin,
        expectedRPID: rpID,
        credential: {
          id: passkey.credentialId,
          publicKey: new Uint8Array(passkey.publicKey),
          counter: Number(passkey.counter),
          transports: passkey.transports,
        },
        // On its own, a passkey is both factors only when the device verified the user.
        requireUserVerification: !signIn.userId,
      });
    } catch {
      return this.recordFailure(token, signIn);
    }
    if (!verification.verified) {
      return this.recordFailure(token, signIn);
    }
    if (!(await this.consumeSignIn(token))) {
      throw new NotAuthenticated('This sign-in expired. Sign in again.');
    }
    await prisma.passkey.update({
      where: {id: passkey.id},
      data: {counter: BigInt(verification.authenticationInfo.newCounter), lastUsedAt: new Date()},
    });
    await redis.del(Keys.TwoFactor.failures(passkey.userId));
    return passkey.userId;
  }

  /** The cached user holds the row as it was; drop it after a change, as password changes do. */
  private static async forgetCachedUser(userId: string): Promise<void> {
    await redis.del(Keys.User.id(userId));
  }
}
