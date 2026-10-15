import type {User} from '@plunk/db';
import type {Response} from 'express';

import {redis, REDIS_ONE_MINUTE} from '../database/redis.js';
import {jwt} from '../middleware/auth.js';
import {Keys} from '../services/keys.js';
import {UserService} from '../services/UserService.js';

/** Signs a user in, as the password sign-in does: the cached user and the session cookie (fork D39). */
export async function startSession(res: Response, user: User): Promise<Response> {
  await redis.set(Keys.User.id(user.id), JSON.stringify(user), 'EX', REDIS_ONE_MINUTE * 60);
  return res.cookie(UserService.COOKIE_NAME, jwt.sign(user.id), UserService.cookieOptions());
}

/** Where an OAuth sign-in of a user with two-factor authentication goes on to its second step (fork D39). */
export function twoFactorStepUrl(
  dashboardUri: string,
  signIn: {challenge: string; methods: {totp: boolean; passkey: boolean}},
) {
  const methods = Object.entries(signIn.methods)
    .filter(([, on]) => on)
    .map(([method]) => method)
    .join(',');
  return `${dashboardUri}/auth/two-factor?challenge=${encodeURIComponent(signIn.challenge)}&methods=${methods}`;
}
