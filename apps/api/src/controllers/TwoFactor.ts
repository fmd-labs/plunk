import {Controller, Delete, Get, Middleware, Post} from '@overnightjs/core';
import {TwoFactorSchemas, UtilitySchemas} from '@plunk/shared';
import type {AuthenticationResponseJSON, RegistrationResponseJSON} from '@simplewebauthn/server';
import type {NextFunction, Request, Response} from 'express';
import jsonwebtoken from 'jsonwebtoken';

import {prisma} from '../database/prisma.js';
import {NotAllowed, NotAuthenticated} from '../exceptions/index.js';
import {isAuthenticated, requireEmailVerified} from '../middleware/auth.js';
import {TwoFactorService} from '../services/TwoFactorService.js';
import {UserService} from '../services/UserService.js';
import {CatchAsync} from '../utils/asyncHandler.js';
import {startSession} from '../utils/session.js';

/** Changes to two-factor authentication need a sign-in from the last this many seconds. */
const RECENT_SIGN_IN_SECONDS = 15 * 60;

/** When the session was signed in, from its token's `iat`; null without one. */
function signedInAt(req: Request): number | null {
  const token: unknown = req.cookies?.[UserService.COOKIE_NAME];
  const payload = typeof token === 'string' ? jsonwebtoken.decode(token) : null;
  return payload && typeof payload === 'object' && typeof payload.iat === 'number' ? payload.iat : null;
}

function isRecentSignIn(req: Request): boolean {
  const iat = signedInAt(req);
  return iat !== null && Date.now() / 1000 - iat <= RECENT_SIGN_IN_SECONDS;
}

/**
 * Factors are added and removed only by a sign-in from the last 15 minutes, so a session that leaked days ago can't
 * add its own passkey or turn the second factor off.
 */
function assertRecentSignIn(req: Request): void {
  if (!isRecentSignIn(req)) {
    throw new NotAllowed('Sign in again to change two-factor authentication', 'recent_sign_in_required');
  }
}

async function signedInUser(res: Response) {
  const userId = res.locals.auth?.userId;
  const user = userId ? await prisma.user.findUnique({where: {id: userId}}) : null;
  if (!user) {
    throw new NotAuthenticated();
  }
  return user;
}

/** Signs in the user a completed second step names. */
async function finishSignIn(res: Response, userId: string) {
  const user = await prisma.user.findUnique({where: {id: userId}});
  if (!user) {
    throw new NotAuthenticated('This sign-in expired. Sign in again.');
  }
  return (await startSession(res, user)).json({success: true, data: {id: user.id, email: user.email}});
}

/**
 * Two-factor authentication (fork D39): the second step of a sign-in, a passkey sign-in on its own, and the
 * signed-in user's factors.
 */
@Controller('two-factor')
export class TwoFactor {
  /**
   * POST /two-factor/code
   * Completes a sign-in with an authenticator code or a recovery code: `{ challenge, code }`
   */
  @Post('code')
  @CatchAsync
  public async code(req: Request, res: Response, _next: NextFunction) {
    const {challenge, code} = TwoFactorSchemas.code.parse(req.body);
    return finishSignIn(res, await TwoFactorService.completeWithCode(challenge, code));
  }

  /**
   * POST /two-factor/passkey/options
   * Options for `navigator.credentials.get`: for the sign-in `challenge` names, or, without one, a passkey sign-in
   * on its own. Answers `{ challenge, options }`.
   */
  @Post('passkey/options')
  @CatchAsync
  public async passkeyOptions(req: Request, res: Response, _next: NextFunction) {
    const {challenge} = TwoFactorSchemas.passkeyOptions.parse(req.body ?? {});
    return res.json(await TwoFactorService.authenticationOptions(challenge));
  }

  /**
   * POST /two-factor/passkey
   * Completes a sign-in with a passkey: `{ challenge, response }`
   */
  @Post('passkey')
  @CatchAsync
  public async passkey(req: Request, res: Response, _next: NextFunction) {
    const {challenge, response} = TwoFactorSchemas.passkey.parse(req.body);
    const userId = await TwoFactorService.completeWithPasskey(
      challenge,
      response as unknown as AuthenticationResponseJSON,
    );
    return finishSignIn(res, userId);
  }

  /**
   * GET /two-factor
   * The signed-in user's factors, and whether the session is recent enough to change them
   */
  @Get('')
  @Middleware([isAuthenticated, requireEmailVerified])
  @CatchAsync
  public async status(req: Request, res: Response, _next: NextFunction) {
    const user = await signedInUser(res);
    return res.json({...(await TwoFactorService.status(user.id)), recentSignIn: isRecentSignIn(req)});
  }

  /**
   * POST /two-factor/totp/setup
   * A new authenticator-app secret and its `otpauth://` URI, until a code confirms it
   */
  @Post('totp/setup')
  @Middleware([isAuthenticated, requireEmailVerified])
  @CatchAsync
  public async setupTotp(req: Request, res: Response, _next: NextFunction) {
    assertRecentSignIn(req);
    return res.json(await TwoFactorService.startTotp(await signedInUser(res)));
  }

  /**
   * POST /two-factor/totp
   * Turns the authenticator app on with a code from the new secret: `{ code }`. The first factor comes with
   * recovery codes, shown once.
   */
  @Post('totp')
  @Middleware([isAuthenticated, requireEmailVerified])
  @CatchAsync
  public async enableTotp(req: Request, res: Response, _next: NextFunction) {
    assertRecentSignIn(req);
    const {code} = TwoFactorSchemas.enableTotp.parse(req.body);
    return res.json(await TwoFactorService.enableTotp((await signedInUser(res)).id, code));
  }

  /**
   * DELETE /two-factor/totp
   * Turns the authenticator app off
   */
  @Delete('totp')
  @Middleware([isAuthenticated, requireEmailVerified])
  @CatchAsync
  public async disableTotp(req: Request, res: Response, _next: NextFunction) {
    assertRecentSignIn(req);
    await TwoFactorService.disableTotp((await signedInUser(res)).id);
    return res.json({success: true});
  }

  /**
   * POST /two-factor/recovery-codes
   * New recovery codes, replacing the old ones; shown once
   */
  @Post('recovery-codes')
  @Middleware([isAuthenticated, requireEmailVerified])
  @CatchAsync
  public async recoveryCodes(req: Request, res: Response, _next: NextFunction) {
    assertRecentSignIn(req);
    return res.json({recoveryCodes: await TwoFactorService.regenerateRecoveryCodes((await signedInUser(res)).id)});
  }

  /**
   * POST /two-factor/passkeys/options
   * Options for `navigator.credentials.create`, to add a passkey
   */
  @Post('passkeys/options')
  @Middleware([isAuthenticated, requireEmailVerified])
  @CatchAsync
  public async passkeyRegistrationOptions(req: Request, res: Response, _next: NextFunction) {
    assertRecentSignIn(req);
    return res.json(await TwoFactorService.registrationOptions(await signedInUser(res)));
  }

  /**
   * POST /two-factor/passkeys
   * Adds the passkey the browser created: `{ name, response }`. The first factor comes with recovery codes.
   */
  @Post('passkeys')
  @Middleware([isAuthenticated, requireEmailVerified])
  @CatchAsync
  public async addPasskey(req: Request, res: Response, _next: NextFunction) {
    assertRecentSignIn(req);
    const {name, response} = TwoFactorSchemas.registerPasskey.parse(req.body);
    const user = await signedInUser(res);
    const added = await TwoFactorService.register(user.id, name, response as unknown as RegistrationResponseJSON);
    return res.status(201).json(added);
  }

  /**
   * DELETE /two-factor/passkeys/:id
   * Removes a passkey
   */
  @Delete('passkeys/:id')
  @Middleware([isAuthenticated, requireEmailVerified])
  @CatchAsync
  public async removePasskey(req: Request, res: Response, _next: NextFunction) {
    assertRecentSignIn(req);
    const {id} = UtilitySchemas.id.parse(req.params);
    await TwoFactorService.removePasskey((await signedInUser(res)).id, id);
    return res.json({success: true});
  }
}
