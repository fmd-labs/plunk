import {CampaignStatus, TemplateType} from '@plunk/db';
import type {ApiKeyScope} from '@plunk/shared';
import type {NextFunction, Request, Response} from 'express';
import {beforeEach, describe, expect, it} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {ApiKeyService} from '../../services/ApiKeyService.js';
import {CampaignService} from '../../services/CampaignService.js';
import {LayoutService} from '../../services/LayoutService.js';
import {requireAuth, requireSecretKey} from '../auth.js';

type Middleware = (req: Request, res: Response, next: NextFunction) => Promise<void>;

/**
 * A request as Express hands it to a route's middleware: the controller's base (the first segment, or up to a `|`),
 * the route matched and its params.
 */
function request(route: string, key: string, options: {params?: Record<string, string>; body?: unknown} = {}) {
  const [method, target] = route.split(' ') as [string, string];
  const split = target.includes('|') ? target.indexOf('|') : target.indexOf('/', 1);
  const [base, path] = split === -1 ? [target, '/'] : [target.slice(0, split), target.slice(split).replace('|', '')];
  return {
    method,
    baseUrl: base,
    route: {path},
    params: options.params ?? {},
    body: options.body ?? {},
    headers: {authorization: `Bearer ${key}`},
    cookies: {},
  } as unknown as Request;
}

/** Runs a middleware, resolving with the error it passed on (none when the request may go ahead). */
async function run(middleware: Middleware, req: Request) {
  const res = {locals: {}} as Response;
  const error = await new Promise<unknown>(resolve => void middleware(req, res, (e?: unknown) => resolve(e)));
  return {error: error as {code?: number; message?: string} | undefined, auth: res.locals.auth};
}

/** Scoped API keys (D37). */
describe('scoped API keys', () => {
  const prisma = getPrismaClient();
  let projectId: string;
  let projectKey: string;

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
    projectKey = project.secret;
  });

  const keyWith = async (...scopes: ApiKeyScope[]) =>
    (await ApiKeyService.create(projectId, {name: 'agent', scopes})).secret;

  const status = async (route: string, key: string, options?: Parameters<typeof request>[2]) =>
    (await run(requireAuth, request(route, key, options))).error?.code ?? 200;

  it('shows the secret once, keeps only its hash, and refuses it once revoked', async () => {
    const {key, secret} = await ApiKeyService.create(projectId, {name: 'agent', scopes: ['draft']});

    expect(secret).toMatch(/^sk_scoped_[0-9a-f]{48}$/);
    expect(key.prefix).toBe(secret.slice(0, 16));
    expect(key).not.toHaveProperty('secretHash');
    const stored = await prisma.apiKey.findUniqueOrThrow({where: {id: key.id}});
    expect(stored.secretHash).not.toContain(secret.slice(10));

    const {auth} = await run(requireAuth, request('GET /campaigns', secret));
    expect(auth).toEqual({type: 'apiKey', projectId, apiKeyId: key.id, scopes: ['draft']});

    await ApiKeyService.revoke(projectId, key.id);
    expect(await status('GET /campaigns', secret)).toBe(401);
    expect(await ApiKeyService.list(projectId)).toEqual([expect.objectContaining({id: key.id, revokedAt: expect.any(Date)})]);
  });

  it('refuses every route its scopes do not list, where the project key goes anywhere', async () => {
    const draft = await keyWith('draft');
    const sync = await keyWith('sync');

    for (const route of ['GET /contacts', 'GET /campaigns/:id/recipients', 'GET /api-keys', 'POST /workflows']) {
      expect(await status(route, draft)).toBe(403);
      expect(await status(route, projectKey)).toBe(200);
    }
    expect(await status('POST /campaigns', sync)).toBe(403);
    expect(await status('POST /contacts/batch', sync)).toBe(200);
    expect(await status('POST /contacts/batch', draft)).toBe(403);
    expect(await status('GET /topics', draft)).toBe(200);

    // Routes behind the secret key alone.
    expect((await run(requireSecretKey, request('POST /v1|/send', sync))).error?.code).toBe(403);
    expect((await run(requireSecretKey, request('POST /v1/emails|/:id/unsubscribed', sync))).error).toBeUndefined();
  });

  it('drafts marketing campaigns, and leaves them once they are no longer drafts', async () => {
    const draft = await keyWith('draft');
    const campaign = await factories.createCampaign({projectId});
    const scheduled = await factories.createCampaign({projectId, status: CampaignStatus.SCHEDULED});
    const transactional = await factories.createCampaign({projectId, type: TemplateType.TRANSACTIONAL});
    const params = (id: string) => ({params: {id}});

    expect(await status('POST /campaigns', draft, {body: {type: 'MARKETING'}})).toBe(200);
    expect(await status('POST /campaigns', draft, {body: {type: 'TRANSACTIONAL'}})).toBe(403);
    expect(await status('PUT /campaigns/:id', draft, params(campaign.id))).toBe(200);
    expect(await status('PUT /campaigns/:id', draft, {...params(campaign.id), body: {type: 'HEADLESS'}})).toBe(403);
    expect(await status('PUT /campaigns/:id', draft, params(scheduled.id))).toBe(403);
    expect(await status('DELETE /campaigns/:id', draft, params(scheduled.id))).toBe(403);
    expect(await status('PUT /campaigns/:id', draft, params(transactional.id))).toBe(403);
    expect(await status('POST /campaigns/:id/duplicate', draft, params(transactional.id))).toBe(403);
    expect(await status('POST /campaigns/:id/test', draft, params(campaign.id))).toBe(200);
    for (const route of ['POST /campaigns/:id/send', 'POST /campaigns/:id/cancel']) {
      expect(await status(route, draft, params(campaign.id))).toBe(403);
    }
  });

  it('changes no template, segment or layout that a live send uses', async () => {
    const draft = await keyWith('draft');
    const both = await keyWith('draft', 'sync');

    const marketing = await factories.createTemplate({projectId});
    const sentByWorkflow = await factories.createTemplate({projectId});
    const workflow = await factories.createWorkflow({projectId});
    await factories.createWorkflowStep({workflowId: workflow.id, templateId: sentByWorkflow.id});
    const transactional = await factories.createTemplate({projectId, type: TemplateType.TRANSACTIONAL});
    expect(await status('PATCH /templates/:id', draft, {params: {id: marketing.id}})).toBe(200);
    expect(await status('PATCH /templates/:id', draft, {params: {id: sentByWorkflow.id}})).toBe(403);
    expect(await status('DELETE /templates/:id', draft, {params: {id: transactional.id}})).toBe(403);

    const idle = await factories.createSegment(projectId);
    const scheduledFor = await factories.createSegment(projectId);
    await prisma.campaign.update({
      where: {id: (await factories.createCampaign({projectId, status: CampaignStatus.SCHEDULED})).id},
      data: {segmentId: scheduledFor.id},
    });
    const named = await factories.createSegment(projectId);
    await factories.createSegment(projectId, {filters: [{field: `segment.${named.id}`, operator: 'equals', value: true}]});
    expect(await status('PATCH /segments/:id', draft, {params: {id: idle.id}})).toBe(200);
    expect(await status('PATCH /segments/:id', draft, {params: {id: scheduledFor.id}})).toBe(403);
    expect(await status('DELETE /segments/:id', draft, {params: {id: named.id}})).toBe(403);

    const html = '<html><body>{{ content }}</body></html>';
    await LayoutService.upsert(projectId, 'brand', {name: 'Brand', html, isDefault: true});
    await LayoutService.upsert(projectId, 'spare', {name: 'Spare', html});
    expect(await status('PUT /layouts/:slug', draft, {params: {slug: 'brand'}})).toBe(403);
    expect(await status('PUT /layouts/:slug', draft, {params: {slug: 'spare'}})).toBe(200);
    expect(await status('PUT /layouts/:slug', draft, {params: {slug: 'new'}})).toBe(200);
    // A key that also syncs may keep the default layout up to date.
    expect(await status('PUT /layouts/:slug', both, {params: {slug: 'brand'}})).toBe(200);
  });

  it('names the key behind a campaign, until a person changes it', async () => {
    const {key} = await ApiKeyService.create(projectId, {name: 'agent', scopes: ['draft']});
    const created = await CampaignService.create(
      projectId,
      {name: 'Drafted', subject: 'Hi', body: '<p>Hi</p>', from: 'news@example.com', audienceType: 'ALL'},
      key.id,
    );
    expect(created).toMatchObject({createdByKeyId: key.id, updatedByKeyId: key.id});

    // Internal changes say nothing about who made them.
    await CampaignService.update(projectId, created.id, {name: 'Renamed'});
    expect(await prisma.campaign.findUniqueOrThrow({where: {id: created.id}})).toMatchObject({updatedByKeyId: key.id});

    await CampaignService.update(projectId, created.id, {name: 'By hand'}, null);
    expect(await prisma.campaign.findUniqueOrThrow({where: {id: created.id}})).toMatchObject({
      createdByKeyId: key.id,
      updatedByKeyId: null,
    });
  });
});
