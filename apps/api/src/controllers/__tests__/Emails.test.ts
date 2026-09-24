import {EmailStatus} from '@plunk/db';
import type {Request, Response} from 'express';
import {beforeEach, describe, expect, it} from 'vitest';
import {ZodError} from 'zod';

import {factories} from '../../../../../test/helpers';
import {ErrorCode, NotFound} from '../../exceptions';
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
