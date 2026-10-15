import {Server} from '@overnightjs/core';
import cookies from 'cookie-parser';
import {json, type NextFunction, type Request, type Response} from 'express';
import jsonwebtoken from 'jsonwebtoken';
import request from 'supertest';
import {beforeEach, describe, expect, it} from 'vitest';
import {ZodError} from 'zod';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {API_URI, JWT_SECRET, S3_PUBLIC_URL} from '../../app/constants';
import {HttpException} from '../../exceptions';
import {Users} from '../Users';

function servedApp() {
  const server = new Server();
  server.app.use(json());
  server.app.use(cookies());
  server.addControllers([new Users()]);
  server.app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
    const status = error instanceof HttpException ? error.code : error instanceof ZodError ? 422 : 500;
    res.status(status).json({message: error.message});
  });
  return server.app;
}

/** Setting a project's avatar (D38). */
describe('project avatar', () => {
  const app = servedApp();
  const prisma = getPrismaClient();
  let projectId: string;
  let owner: string;

  beforeEach(async () => {
    const {user, project} = await factories.createUserWithProject();
    projectId = project.id;
    owner = `next_token=${jsonwebtoken.sign({id: user.id}, JWT_SECRET)}`;
  });

  const setAvatar = (avatarUrl: unknown, cookie = owner) =>
    request(app).patch(`/users/@me/projects/${projectId}`).set('Cookie', cookie).send({avatarUrl});
  const stored = async () => (await prisma.project.findUniqueOrThrow({where: {id: projectId}})).avatarUrl;

  it('stores an image URL as the browser reads it, and removes it when empty', async () => {
    expect((await setAvatar('https://cdn.example.com/brand logo.png')).status).toBe(200);
    expect(await stored()).toBe('https://cdn.example.com/brand%20logo.png');

    expect((await setAvatar('')).status).toBe(200);
    expect(await stored()).toBeNull();
  });

  it('refuses URLs without a host, and any on the API, where a GET can sign members out', async () => {
    for (const value of ['https:example.com/a.png', 'http:/example.com/a.png', `${API_URI}/auth/logout`]) {
      expect((await setAvatar(value)).status, value).toBeGreaterThanOrEqual(400);
    }
    expect(await stored()).toBeNull();
    // An upload's public URL is fine, wherever it is served.
    if (S3_PUBLIC_URL) {
      expect((await setAvatar(`${S3_PUBLIC_URL}/${projectId}/logo.png`)).status).toBe(200);
    }
  });

  it('is set by admins and owners only', async () => {
    const member = await factories.createUser();
    await prisma.membership.create({data: {userId: member.id, projectId, role: 'MEMBER'}});
    const memberCookie = `next_token=${jsonwebtoken.sign({id: member.id}, JWT_SECRET)}`;

    expect((await setAvatar('https://cdn.example.com/logo.png', memberCookie)).status).toBe(403);
    expect(await stored()).toBeNull();
  });
});
