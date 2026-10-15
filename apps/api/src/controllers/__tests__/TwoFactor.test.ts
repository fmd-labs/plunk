import {Server} from '@overnightjs/core';
import cookies from 'cookie-parser';
import {json, type NextFunction, type Request, type Response} from 'express';
import jsonwebtoken from 'jsonwebtoken';
import request from 'supertest';
import {beforeEach, describe, expect, it} from 'vitest';
import {ZodError} from 'zod';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {JWT_SECRET} from '../../app/constants';
import {HttpException} from '../../exceptions';
import {SoftAuthenticator} from '../../services/__tests__/softAuthenticator';
import {base32Decode, totpCode, totpStep} from '../../services/Totp';
import {TwoFactorService} from '../../services/TwoFactorService';
import {Auth} from '../Auth';
import {TwoFactor} from '../TwoFactor';

/** The sign-in and two-factor routes as the API serves them, answering errors with their status. */
function servedApp() {
  const server = new Server();
  server.app.use(json());
  server.app.use(cookies());
  server.addControllers([new Auth(), new TwoFactor()]);
  server.app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
    const status = error instanceof HttpException ? error.code : error instanceof ZodError ? 422 : 500;
    res.status(status).json({message: error.message, details: (error as HttpException).details});
  });
  return server.app;
}

const PASSWORD = 'correct horse battery';

/** Two-factor authentication (D39). */
describe('two-factor authentication', () => {
  const app = servedApp();
  const prisma = getPrismaClient();
  let user: {id: string; email: string};
  let session: string;

  beforeEach(async () => {
    user = await factories.createUser({password: PASSWORD});
    session = `next_token=${jsonwebtoken.sign({id: user.id}, JWT_SECRET)}`;
  });

  const signIn = () => request(app).post('/auth/login').send({email: user.email, password: PASSWORD});
  const sessionCookie = (answer: request.Response) =>
    ([] as string[]).concat(answer.headers['set-cookie'] ?? []).find(cookie => cookie.startsWith('next_token='));

  /** Turns the authenticator app on, as the settings page does; the secret and the recovery codes. */
  async function enableTotp() {
    const setup = await request(app).post('/two-factor/totp/setup').set('Cookie', session);
    expect(setup.status).toBe(200);
    const secret = setup.body.secret as string;
    const enabled = await request(app)
      .post('/two-factor/totp')
      .set('Cookie', session)
      .send({code: totpCode(base32Decode(secret), totpStep())});
    expect(enabled.status).toBe(200);
    return {secret, recoveryCodes: enabled.body.recoveryCodes as string[]};
  }

  /** A code from a step that hasn't been used yet: the next one, which the window still accepts. */
  const nextCode = (secret: string) => totpCode(base32Decode(secret), totpStep() + 1);

  it('turns the authenticator app on with a code from the new secret, keeps the secret encrypted, and hands out recovery codes once', async () => {
    const setup = await request(app).post('/two-factor/totp/setup').set('Cookie', session);
    expect(setup.body.uri).toMatch(/^otpauth:\/\/totp\/Plunk:.+\?secret=[A-Z2-7]+&issuer=Plunk/);
    const wrong = await request(app).post('/two-factor/totp').set('Cookie', session).send({code: '000000'});
    expect(wrong.status).toBe(400);

    const enabled = await request(app)
      .post('/two-factor/totp')
      .set('Cookie', session)
      .send({code: totpCode(base32Decode(setup.body.secret), totpStep())});
    expect(enabled.body.recoveryCodes).toHaveLength(10);
    expect(enabled.body.recoveryCodes[0]).toMatch(/^[a-z2-7]{5}-[a-z2-7]{5}$/);

    const stored = await prisma.user.findUniqueOrThrow({where: {id: user.id}});
    expect(stored.totpEnabledAt).not.toBeNull();
    expect(stored.totpSecret).not.toContain(setup.body.secret);
    expect(TwoFactorService.decryptSecret(stored.totpSecret!)).toBe(setup.body.secret);

    const status = await request(app).get('/two-factor').set('Cookie', session);
    expect(status.body).toMatchObject({passkeys: [], recoveryCodesLeft: 10, recentSignIn: true});
    expect(status.body.totpEnabledAt).toBeTruthy();
  });

  it('asks for a second step after the password, and takes each authenticator code once', async () => {
    expect(sessionCookie(await signIn())).toBeDefined();
    const {secret} = await enableTotp();

    const first = await signIn();
    expect(first.body).toMatchObject({success: 'twoFactor', data: {methods: {totp: true, passkey: false}}});
    expect(sessionCookie(first)).toBeUndefined();

    const code = nextCode(secret);
    const done = await request(app).post('/two-factor/code').send({challenge: first.body.data.challenge, code});
    expect(done.status).toBe(200);
    expect(sessionCookie(done)).toBeDefined();
    // The token signed in once.
    const again = await request(app).post('/two-factor/code').send({challenge: first.body.data.challenge, code});
    expect(again.status).toBe(401);

    // The same code on a new sign-in is spent.
    const second = await signIn();
    const replay = await request(app).post('/two-factor/code').send({challenge: second.body.data.challenge, code});
    expect(replay.status).toBe(400);
  });

  it('signs in with a recovery code once', async () => {
    const {recoveryCodes} = await enableTotp();
    const code = recoveryCodes[3]!.toUpperCase();

    const first = await signIn();
    const done = await request(app).post('/two-factor/code').send({challenge: first.body.data.challenge, code});
    expect(sessionCookie(done)).toBeDefined();

    const second = await signIn();
    const reused = await request(app).post('/two-factor/code').send({challenge: second.body.data.challenge, code});
    expect(reused.status).toBe(400);
    expect(await prisma.recoveryCode.count({where: {userId: user.id}})).toBe(9);
  });

  it('ends a sign-in after five wrong codes, and holds the user off after ten across sign-ins', async () => {
    await enableTotp();
    const {challenge} = (await signIn()).body.data;
    const statuses = [];
    for (let i = 0; i < 5; i++) {
      statuses.push((await request(app).post('/two-factor/code').send({challenge, code: '111111'})).status);
    }
    expect(statuses).toEqual([400, 400, 400, 400, 401]);

    const next = (await signIn()).body.data.challenge;
    for (let i = 0; i < 4; i++) {
      await request(app).post('/two-factor/code').send({challenge: next, code: '111111'});
    }
    const last = await signIn();
    const held = await request(app).post('/two-factor/code').send({challenge: last.body.data.challenge, code: '111111'});
    expect(held.status).toBe(429);
  });

  it('adds a passkey, and signs in with it after the password or on its own', async () => {
    const {origin, rpID} = TwoFactorService.relyingParty();
    const device = new SoftAuthenticator(origin, rpID);

    const options = await request(app).post('/two-factor/passkeys/options').set('Cookie', session);
    expect(options.body).toMatchObject({rp: {id: rpID}, authenticatorSelection: {residentKey: 'required'}});
    const added = await request(app)
      .post('/two-factor/passkeys')
      .set('Cookie', session)
      .send({name: 'Laptop', response: device.register(options.body)});
    expect(added.status).toBe(201);
    expect(added.body.passkey).toMatchObject({name: 'Laptop', deviceType: 'singleDevice'});
    expect(added.body.recoveryCodes).toHaveLength(10);

    // After the password.
    const first = await signIn();
    expect(first.body.data.methods).toEqual({totp: false, passkey: true});
    const step = await request(app).post('/two-factor/passkey/options').send({challenge: first.body.data.challenge});
    expect(step.body.options.allowCredentials).toHaveLength(1);
    const viaPasskey = await request(app)
      .post('/two-factor/passkey')
      .send({challenge: step.body.challenge, response: device.authenticate(step.body.options)});
    expect(viaPasskey.status).toBe(200);
    expect(sessionCookie(viaPasskey)).toBeDefined();

    // On its own.
    const own = await request(app).post('/two-factor/passkey/options').send({});
    expect(own.body.options.allowCredentials ?? []).toEqual([]);
    const passwordless = await request(app)
      .post('/two-factor/passkey')
      .send({challenge: own.body.challenge, response: device.authenticate(own.body.options, user.id)});
    expect(passwordless.status).toBe(200);
    expect(passwordless.body.data).toEqual({id: user.id, email: user.email});
    expect((await prisma.passkey.findFirstOrThrow({where: {userId: user.id}})).counter).toBe(2n);

    // Another user's password step doesn't take this user's passkey.
    const other = await factories.createUser({password: PASSWORD});
    const otherDevice = new SoftAuthenticator(origin, rpID);
    const otherSession = `next_token=${jsonwebtoken.sign({id: other.id}, JWT_SECRET)}`;
    const otherOptions = await request(app).post('/two-factor/passkeys/options').set('Cookie', otherSession);
    await request(app)
      .post('/two-factor/passkeys')
      .set('Cookie', otherSession)
      .send({name: 'Phone', response: otherDevice.register(otherOptions.body)});
    const otherSignIn = await request(app).post('/auth/login').send({email: other.email, password: PASSWORD});
    const otherStep = await request(app)
      .post('/two-factor/passkey/options')
      .send({challenge: otherSignIn.body.data.challenge});
    const wrongUser = await request(app)
      .post('/two-factor/passkey')
      .send({challenge: otherStep.body.challenge, response: device.authenticate(otherStep.body.options)});
    expect(wrongUser.status).toBe(400);
  });

  it('takes a passkey on its own only from a device that verified the user', async () => {
    const {origin, rpID} = TwoFactorService.relyingParty();
    const key = new SoftAuthenticator(origin, rpID, false);
    const options = await request(app).post('/two-factor/passkeys/options').set('Cookie', session);
    await request(app)
      .post('/two-factor/passkeys')
      .set('Cookie', session)
      .send({name: 'Security key', response: key.register(options.body)});

    const own = await request(app).post('/two-factor/passkey/options').send({});
    const refused = await request(app)
      .post('/two-factor/passkey')
      .send({challenge: own.body.challenge, response: key.authenticate(own.body.options)});
    expect(refused.status).toBe(400);

    // As the second step, after the password, presence is enough.
    const first = await signIn();
    const step = await request(app).post('/two-factor/passkey/options').send({challenge: first.body.data.challenge});
    const done = await request(app)
      .post('/two-factor/passkey')
      .send({challenge: step.body.challenge, response: key.authenticate(step.body.options)});
    expect(done.status).toBe(200);
  });

  it('changes factors only from a sign-in of the last 15 minutes', async () => {
    const old = `next_token=${jsonwebtoken.sign({id: user.id, iat: Math.floor(Date.now() / 1000) - 16 * 60}, JWT_SECRET)}`;
    for (const [method, path] of [
      ['post', '/two-factor/totp/setup'],
      ['delete', '/two-factor/totp'],
      ['post', '/two-factor/recovery-codes'],
      ['post', '/two-factor/passkeys/options'],
    ] as const) {
      const answer = await request(app)[method](path).set('Cookie', old);
      expect(answer.status, path).toBe(403);
      expect(answer.body.details).toEqual({reason: 'recent_sign_in_required'});
    }
    expect((await request(app).get('/two-factor').set('Cookie', old)).body.recentSignIn).toBe(false);
  });

  it('drops the recovery codes with the last factor', async () => {
    await enableTotp();
    const removed = await request(app).delete('/two-factor/totp').set('Cookie', session);
    expect(removed.status).toBe(200);
    expect(await prisma.recoveryCode.count({where: {userId: user.id}})).toBe(0);
    expect((await signIn()).body.success).toBe(true);
  });
});
