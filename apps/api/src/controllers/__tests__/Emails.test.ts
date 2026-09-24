import {Server} from '@overnightjs/core';
import {EmailStatus} from '@plunk/db';
import type {NextFunction, Request, Response} from 'express';
import request from 'supertest';
import {beforeEach, describe, expect, it} from 'vitest';
import {ZodError} from 'zod';

import {factories} from '../../../../../test/helpers';
import {ErrorCode, HttpException, NotFound} from '../../exceptions';
import {Emails} from '../Emails';

/**
 * Call the handler and settle on whichever it does: answer, or hand an error to `next`.
 * `CatchAsync` does not return the handler's promise, so awaiting the call would not wait for it.
 */
function getEmail(id: string, projectId: string) {
  return new Promise<{status: number; body: unknown} | {error: unknown}>(resolve => {
    let status = 200;
    const res = {
      locals: {auth: {type: 'apiKey', projectId}},
      status(code: number) {
        status = code;
        return this;
      },
      json(body: unknown) {
        resolve({status, body});
        return this;
      },
    } as unknown as Response;
    new Emails().get({params: {id}} as unknown as Request, res, error => resolve({error}));
  });
}

describe('GET /v1/emails/:id', () => {
  let projectId: string;
  let contactId: string;

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
    contactId = (await factories.createContact({projectId})).id;
  });

  it("returns the email's status, event times and counts", async () => {
    const sentAt = new Date('2026-01-02T03:04:05.000Z');
    const email = await factories.createEmail(projectId, contactId, {
      status: EmailStatus.SENT,
      sentAt,
      messageId: 'ses-message-id',
      opens: 2,
    });

    const result = await getEmail(email.id, projectId);

    expect(result).toEqual({
      status: 200,
      body: {
        success: true,
        data: expect.objectContaining({
          id: email.id,
          status: EmailStatus.SENT,
          messageId: 'ses-message-id',
          contactId,
          sentAt,
          deliveredAt: null,
          opens: 2,
          clicks: 0,
          error: null,
        }),
      },
    });
  });

  it('leaves out the content of the email', async () => {
    const email = await factories.createEmail(projectId, contactId, {subject: 'Private', body: '<p>Private</p>'});

    const result = await getEmail(email.id, projectId);

    const data = (result as {body: {data: Record<string, unknown>}}).body.data;
    for (const field of ['subject', 'body', 'from', 'fromName', 'replyTo', 'headers', 'attachments', 'toName']) {
      expect(data).not.toHaveProperty(field);
    }
  });

  it("answers 404 for another project's email, as for one that does not exist", async () => {
    const {project: other} = await factories.createUserWithProject();
    const othersContact = await factories.createContact({projectId: other.id});
    const othersEmail = await factories.createEmail(other.id, othersContact.id);

    const foreign = await getEmail(othersEmail.id, projectId);
    const missing = await getEmail('00000000-0000-4000-8000-000000000000', projectId);

    for (const result of [foreign, missing]) {
      expect(result).toEqual({error: expect.any(NotFound)});
      expect((result as {error: NotFound}).error).toMatchObject({code: 404, errorCode: ErrorCode.RESOURCE_NOT_FOUND});
    }
  });

  it('rejects an id that is not a UUID', async () => {
    expect(await getEmail('not-an-id', projectId)).toEqual({error: expect.any(ZodError)});
  });
});

/**
 * The endpoint as it is served: its route and middleware, with errors answered by their status as
 * the API's error handler does.
 */
function servedApp() {
  const server = new Server();
  server.addControllers([new Emails()]);
  server.app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
    const status = error instanceof HttpException ? error.code : error instanceof ZodError ? 422 : 500;
    res.status(status).json({success: false, error: error.message});
  });
  return server.app;
}

describe('GET /v1/emails/:id over HTTP', () => {
  it("answers only to the secret key of the email's project", async () => {
    const app = servedApp();
    const {project} = await factories.createUserWithProject();
    const {project: other} = await factories.createUserWithProject();
    const contact = await factories.createContact({projectId: project.id});
    const email = await factories.createEmail(project.id, contact.id);
    const get = (id: string, key?: string) => {
      const call = request(app).get(`/v1/emails/${id}`);
      return key === undefined ? call : call.set('Authorization', `Bearer ${key}`);
    };

    expect((await get(email.id)).status).toBe(401);
    expect((await get(email.id, project.public)).status).toBe(401);
    expect((await get(email.id, other.secret)).status).toBe(404);
    expect((await get('not-an-id', project.secret)).status).toBe(422);
    const answer = await get(email.id, project.secret);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({success: true, data: {id: email.id}});
  });
});
