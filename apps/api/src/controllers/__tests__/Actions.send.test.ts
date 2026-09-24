import {EmailSourceType, EmailStatus, TemplateType} from '@plunk/db';
import type {Request, Response} from 'express';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ZodError} from 'zod';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {DASHBOARD_URI} from '../../app/constants';
import {ErrorCode, HttpException, NotFound, ValidationError} from '../../exceptions';
import {BillingLimitService} from '../../services/BillingLimitService';
import {emailQueue} from '../../services/QueueService';
import {Actions} from '../Actions';

/**
 * What POST /v1/send does today, pinned before its logic moves: the handler is called directly with
 * a stand-in request and response, after the auth, rate-limit and idempotency middleware would
 * have run.
 */

interface SendResponse {
  success: boolean;
  data: {emails: {contact: {id: string; email: string}; email: string}[]; timestamp: string};
}

type SendOutcome = {status: number; body: SendResponse} | {error: unknown};

/**
 * Call the handler and settle on whichever it does: answer, or hand an error to `next`.
 * `CatchAsync` does not return the handler's promise, so awaiting the call would not wait for it.
 */
function send(projectId: string, body: unknown) {
  return new Promise<SendOutcome>(resolve => {
    let status = 200;
    const res = {
      locals: {auth: {type: 'apiKey', projectId}},
      status(code: number) {
        status = code;
        return this;
      },
      json(payload: SendResponse) {
        resolve({status, body: payload});
        return this;
      },
    } as unknown as Response;
    new Actions().send({body} as unknown as Request, res, error => resolve({error}));
  });
}

function answer(outcome: SendOutcome) {
  if ('error' in outcome) {
    throw outcome.error;
  }
  return outcome;
}

function failure(outcome: SendOutcome) {
  if (!('error' in outcome)) {
    throw new Error(`Expected the request to fail, but it answered ${outcome.status}`);
  }
  return outcome.error;
}

describe('POST /v1/send', () => {
  const prisma = getPrismaClient();
  let projectId: string;

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
    await factories.createDomain({projectId, domain: 'example.com'});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function storedEmail(outcome: {body: SendResponse}, index = 0) {
    return prisma.email.findUniqueOrThrow({where: {id: outcome.body.data.emails[index]!.email}});
  }

  it('queues one transactional email per recipient and answers with their ids', async () => {
    const before = Date.now();
    const outcome = answer(
      await send(projectId, {
        to: ['Ada@Example.com', {name: 'Grace Hopper', email: 'grace@example.com'}],
        subject: 'Hello',
        body: '<p>Hello</p>',
        from: 'sender@example.com',
      }),
    );
    const after = Date.now();

    expect(outcome).toEqual({
      status: 200,
      body: {
        success: true,
        data: {
          emails: [
            {contact: {id: expect.any(String), email: 'ada@example.com'}, email: expect.any(String)},
            {contact: {id: expect.any(String), email: 'grace@example.com'}, email: expect.any(String)},
          ],
          timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        },
      },
    });
    // The timestamp is taken while the request runs.
    const timestamp = Date.parse(outcome.body.data.timestamp);
    expect(timestamp).toBeGreaterThanOrEqual(before);
    expect(timestamp).toBeLessThanOrEqual(after);

    for (const [index, result] of outcome.body.data.emails.entries()) {
      expect(await storedEmail(outcome, index)).toMatchObject({
        projectId,
        contactId: result.contact.id,
        subject: 'Hello',
        body: '<p>Hello</p>',
        from: 'sender@example.com',
        fromName: null,
        toName: index === 0 ? null : 'Grace Hopper',
        replyTo: null,
        templateId: null,
        sourceType: EmailSourceType.TRANSACTIONAL,
        status: EmailStatus.PENDING,
      });

      const job = await emailQueue.getJob(`email-${result.email}`);
      expect(job?.data).toEqual({emailId: result.email});
      expect(job?.opts.priority).toBe(1);
    }

    // New contacts start unsubscribed, and a recipient's name is saved to its contact.
    const contacts = await prisma.contact.findMany({where: {projectId}, orderBy: {email: 'asc'}});
    expect(contacts.map(({email, subscribed, data}) => ({email, subscribed, data}))).toEqual([
      {email: 'ada@example.com', subscribed: false, data: null},
      {email: 'grace@example.com', subscribed: false, data: {name: 'Grace Hopper'}},
    ]);
  });

  it.each([
    {from: {name: 'Object Name', email: 'sender@example.com'}, name: 'Field Name', fromName: 'Object Name'},
    {from: {email: 'sender@example.com'}, name: 'Field Name', fromName: 'Field Name'},
    {from: 'sender@example.com', name: 'Field Name', fromName: 'Field Name'},
    {from: 'sender@example.com', name: undefined, fromName: null},
  ])('takes the sender name from `from`, then `name` ($fromName)', async ({from, name, fromName}) => {
    const outcome = answer(
      await send(projectId, {to: 'ada@example.com', subject: 'Hi', body: '<p>Hi</p>', from, name}),
    );

    expect(await storedEmail(outcome)).toMatchObject({from: 'sender@example.com', fromName});
  });

  it('renders placeholders from the data, the contact and system variables', async () => {
    await factories.createContact({projectId, email: 'ada@example.com', data: {company: 'Analytical Engines'}});

    const outcome = answer(
      await send(projectId, {
        to: 'ada@example.com',
        subject: 'Hi {{ firstName }}',
        body:
          '<p>{{firstName}} at {{company}}, code {{code}}, {{email}}.</p>' +
          '<p>[{{missing}}] {{nickname ?? friend}} {{firstName ?? stranger}}</p><a href="{{unsubscribeUrl}}">x</a>',
        from: 'sender@example.com',
        data: {firstName: 'Ada', code: {value: 'X-1', persistent: false}},
      }),
    );

    const contactId = outcome.body.data.emails[0]!.contact.id;
    expect(await storedEmail(outcome)).toMatchObject({
      subject: 'Hi Ada',
      body:
        '<p>Ada at Analytical Engines, code X-1, ada@example.com.</p>' +
        `<p>[] friend Ada</p><a href="${DASHBOARD_URI}/unsubscribe/${contactId}">x</a>`,
    });
    // Non-persistent values are used for this email only.
    expect((await prisma.contact.findUniqueOrThrow({where: {id: contactId}})).data).toEqual({
      company: 'Analytical Engines',
      firstName: 'Ada',
    });
  });

  it('fills subject, body, sender and reply-to from a template, and the request overrides them', async () => {
    const template = await factories.createTemplate({
      projectId,
      subject: 'Template subject',
      body: '<p>Template body</p>',
      from: 'template@example.com',
      fromName: 'Template Sender',
      type: TemplateType.TRANSACTIONAL,
    });
    await prisma.template.update({where: {id: template.id}, data: {replyTo: 'replies@example.com'}});

    const fromTemplate = answer(await send(projectId, {to: 'ada@example.com', template: template.id}));
    const overridden = answer(
      await send(projectId, {
        to: 'ada@example.com',
        template: template.id,
        subject: 'Own subject',
        from: {name: 'Own Sender', email: 'own@example.com'},
        reply: 'own-replies@example.com',
      }),
    );

    expect(await storedEmail(fromTemplate)).toMatchObject({
      subject: 'Template subject',
      body: '<p>Template body</p>',
      from: 'template@example.com',
      fromName: 'Template Sender',
      replyTo: 'replies@example.com',
      templateId: template.id,
    });
    expect(await storedEmail(overridden)).toMatchObject({
      subject: 'Own subject',
      body: '<p>Template body</p>',
      from: 'own@example.com',
      fromName: 'Own Sender',
      replyTo: 'own-replies@example.com',
      templateId: template.id,
    });
  });

  it('stores custom headers and attachments on the email', async () => {
    const attachment = {
      filename: 'notes.txt',
      content: Buffer.from('Notes').toString('base64'),
      contentType: 'text/plain',
    };

    const outcome = answer(
      await send(projectId, {
        to: 'ada@example.com',
        subject: 'Hi',
        body: '<p>Hi</p>',
        from: 'sender@example.com',
        headers: {'X-Custom': 'yes'},
        attachments: [attachment],
      }),
    );

    expect(await storedEmail(outcome)).toMatchObject({
      headers: {'X-Custom': 'yes'},
      attachments: [{...attachment, disposition: 'attachment'}],
    });
  });

  it("keeps an existing contact's subscription unless the request sets it", async () => {
    await factories.createContact({projectId, email: 'subscribed@example.com', subscribed: true});
    await factories.createContact({projectId, email: 'unsubscribed@example.com', subscribed: false});
    const message = {subject: 'Hi', body: '<p>Hi</p>', from: 'sender@example.com'};

    answer(await send(projectId, {...message, to: ['subscribed@example.com', 'unsubscribed@example.com']}));
    answer(await send(projectId, {...message, to: 'new@example.com', subscribed: true}));

    const contacts = await prisma.contact.findMany({where: {projectId}, orderBy: {email: 'asc'}});
    expect(contacts.map(({email, subscribed}) => ({email, subscribed}))).toEqual([
      {email: 'new@example.com', subscribed: true},
      {email: 'subscribed@example.com', subscribed: true},
      {email: 'unsubscribed@example.com', subscribed: false},
    ]);
  });

  it('rejects an invalid request body', async () => {
    const error = failure(await send(projectId, {subject: 'Hi', body: '<p>Hi</p>', from: 'sender@example.com'}));

    expect(error).toBeInstanceOf(ZodError);
  });

  it('answers 404 for a template that does not exist or belongs to another project', async () => {
    const {project: other} = await factories.createUserWithProject();
    const othersTemplate = await factories.createTemplate({projectId: other.id});

    for (const template of [othersTemplate.id, '00000000-0000-4000-8000-000000000000']) {
      const error = failure(await send(projectId, {to: 'ada@example.com', template}));

      expect(error).toBeInstanceOf(NotFound);
      expect(error).toMatchObject({code: 404, errorCode: ErrorCode.TEMPLATE_NOT_FOUND});
    }
    expect(await prisma.email.count({where: {projectId}})).toBe(0);
  });

  it('requires a sender, from the request or the template', async () => {
    const error = failure(await send(projectId, {to: 'ada@example.com', subject: 'Hi', body: '<p>Hi</p>'}));

    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toMatchObject({code: 422, errors: [{field: 'from', code: 'required'}]});
  });

  // The errors below carry no error code today, so the API reports them as INTERNAL_SERVER_ERROR
  // with their 4xx status.

  it.each([
    {case: 'not registered', from: 'sender@unregistered.example'},
    {case: "another project's", from: 'sender@other.example'},
    {case: 'not verified', from: 'sender@pending.example'},
  ])('refuses a sender domain that is $case, before any contact is written', async ({from}) => {
    const {project: other} = await factories.createUserWithProject();
    await factories.createDomain({projectId: other.id, domain: 'other.example'});
    await factories.createDomain({projectId, domain: 'pending.example', verified: false});

    const error = failure(await send(projectId, {to: 'ada@example.com', subject: 'Hi', body: '<p>Hi</p>', from}));

    expect(error).toBeInstanceOf(HttpException);
    expect(error).toMatchObject({code: 403, errorCode: undefined});
    expect(await prisma.contact.count({where: {projectId}})).toBe(0);
  });

  it('refuses a marketing template for an unsubscribed contact', async () => {
    const template = await factories.createTemplate({
      projectId,
      from: 'sender@example.com',
      type: TemplateType.MARKETING,
    });

    const error = failure(await send(projectId, {to: 'ada@example.com', template: template.id}));

    expect(error).toBeInstanceOf(HttpException);
    expect(error).toMatchObject({code: 400, errorCode: undefined});
    expect(await prisma.email.count({where: {projectId}})).toBe(0);
  });

  it('refuses when the transactional billing limit is reached', async () => {
    vi.spyOn(BillingLimitService, 'checkLimit').mockResolvedValue({
      allowed: false,
      warning: false,
      usage: 100,
      limit: 100,
      percentage: 100,
      message: 'Transactional limit reached',
    });

    const error = failure(
      await send(projectId, {to: 'ada@example.com', subject: 'Hi', body: '<p>Hi</p>', from: 'sender@example.com'}),
    );

    expect(error).toBeInstanceOf(HttpException);
    expect(error).toMatchObject({code: 429, errorCode: undefined, message: 'Transactional limit reached'});
    expect(await prisma.email.count({where: {projectId}})).toBe(0);
  });

  it('keeps the emails already queued for earlier recipients when a later one fails', async () => {
    const template = await factories.createTemplate({
      projectId,
      from: 'sender@example.com',
      type: TemplateType.MARKETING,
    });
    await factories.createContact({projectId, email: 'subscribed@example.com', subscribed: true});

    const error = failure(
      await send(projectId, {to: ['subscribed@example.com', 'unsubscribed@example.com'], template: template.id}),
    );

    expect(error).toMatchObject({code: 400});
    const emails = await prisma.email.findMany({where: {projectId}, include: {contact: true}});
    expect(emails.map(({contact, status}) => ({email: contact.email, status}))).toEqual([
      {email: 'subscribed@example.com', status: EmailStatus.PENDING},
    ]);
    expect(await emailQueue.getJob(`email-${emails[0]!.id}`)).toBeDefined();
  });
});
