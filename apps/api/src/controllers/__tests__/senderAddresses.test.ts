import {Server} from '@overnightjs/core';
import {json, type NextFunction, type Request, type Response} from 'express';
import request from 'supertest';
import {beforeEach, describe, expect, it} from 'vitest';
import {ZodError} from 'zod';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {HttpException} from '../../exceptions';
import {Campaigns} from '../Campaigns';
import {Templates} from '../Templates';

/** Fork (D42): a template's or campaign's sender and reply-to are addresses on every write. */
function servedApp() {
  const server = new Server();
  server.app.use(json());
  server.addControllers([new Campaigns(), new Templates()]);
  server.app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
    const status = error instanceof ZodError ? 422 : error instanceof HttpException ? error.code : 500;
    res.status(status).json({message: error.message});
  });
  return server.app;
}

describe('sender and reply-to addresses (D42)', () => {
  const prisma = getPrismaClient();
  const app = servedApp();
  let projectId: string;
  let secret: string;

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
    secret = project.secret;
    await factories.createDomain({projectId, domain: 'example.com'});
  });

  const auth = (sent: request.Test) => sent.set('Authorization', `Bearer ${secret}`);

  it('refuses a campaign update whose reply-to or sender is not an address', async () => {
    const campaign = await factories.createCampaign({projectId});

    for (const body of [
      {replyTo: 'support@example.com\nX-Injected: 1'},
      {replyTo: 'not an address'},
      {from: 'x\nX-Evil: 1\nhello@example.com'},
      {from: ''},
    ]) {
      const answer = await auth(request(app).put(`/campaigns/${campaign.id}`)).send(body);
      expect(answer.status, JSON.stringify(body)).toBe(422);
    }
    const stored = await prisma.campaign.findUniqueOrThrow({where: {id: campaign.id}});
    expect(stored.replyTo).toBe(campaign.replyTo);
    expect(stored.from).toBe(campaign.from);
  });

  it('takes a valid reply-to, and clears it for an empty string or null', async () => {
    const campaign = await factories.createCampaign({projectId});

    expect((await auth(request(app).put(`/campaigns/${campaign.id}`)).send({replyTo: 'help@example.com'})).status).toBe(200);
    expect((await prisma.campaign.findUniqueOrThrow({where: {id: campaign.id}})).replyTo).toBe('help@example.com');

    expect((await auth(request(app).put(`/campaigns/${campaign.id}`)).send({replyTo: ''})).status).toBe(200);
    expect((await prisma.campaign.findUniqueOrThrow({where: {id: campaign.id}})).replyTo).toBeNull();
  });

  it('refuses a template whose reply-to or sender is not an address, on create and update', async () => {
    const template = await factories.createTemplate({projectId, from: 'hello@example.com'});

    const created = await auth(request(app).post('/templates')).send({
      name: 'Welcome',
      subject: 'Hi',
      body: '<p>Hi</p>',
      from: 'hello@example.com',
      replyTo: 'support@example.com\r\nBcc: someone@example.org',
    });
    expect(created.status).toBe(422);

    const updated = await auth(request(app).patch(`/templates/${template.id}`)).send({from: 'nobody'});
    expect(updated.status).toBe(422);

    const cleared = await auth(request(app).patch(`/templates/${template.id}`)).send({replyTo: ''});
    expect(cleared.status).toBe(200);
  });
});
