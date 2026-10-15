import {CampaignStatus, TemplateType} from '@plunk/db';
import type {ApiKeyScope} from '@plunk/shared';
import type {Request} from 'express';

import {prisma} from '../database/prisma.js';
import {NotAllowed} from '../exceptions/index.js';

/**
 * What scoped API keys may call (fork D37). Default deny: a route is open to a scope only when it is listed here,
 * so a route upstream adds stays closed to scoped keys until it is listed. A grant is `true`, or a check that
 * throws when the request may not go ahead.
 *
 * The `draft` scope prepares marketing campaigns for a person to send. It never sends, schedules or cancels, never
 * reads contacts, and never changes anything a live send uses: a campaign once it is no longer a draft, a template
 * a workflow sends, a segment or layout a scheduled or sending campaign uses.
 */
type Grant = true | ((req: Request, projectId: string) => Promise<unknown>);

const LIVE_CAMPAIGN_STATUSES = [CampaignStatus.SCHEDULED, CampaignStatus.SENDING];

const refuse = (reason: string) => new NotAllowed(`This API key can't do that: ${reason}.`);

const param = (req: Request, name: string) => String(req.params[name] ?? '');

/** A body that leaves the type out, or keeps it marketing. */
async function marketingBody(req: Request): Promise<void> {
  const type = (req.body as {type?: unknown} | undefined)?.type;
  if (type !== undefined && type !== TemplateType.MARKETING) {
    throw refuse('it drafts marketing email only');
  }
}

/** The campaign a route names, if it is the project's. Unknown ids pass the checks, for the route's own 404. */
async function marketingCampaign(req: Request, projectId: string) {
  const campaign = await prisma.campaign.findFirst({
    where: {id: param(req, 'id'), projectId},
    select: {status: true, type: true},
  });
  if (campaign && campaign.type !== TemplateType.MARKETING) {
    throw refuse('the campaign is not a marketing campaign');
  }
  return campaign;
}

/** A marketing campaign that is still a draft, and stays marketing. */
async function draftCampaign(req: Request, projectId: string): Promise<void> {
  await marketingBody(req);
  const campaign = await marketingCampaign(req, projectId);
  if (campaign && campaign.status !== CampaignStatus.DRAFT) {
    throw refuse('the campaign is no longer a draft');
  }
}

/** A marketing template, staying marketing. */
async function marketingTemplate(req: Request, projectId: string): Promise<void> {
  await marketingBody(req);
  const template = await prisma.template.findFirst({where: {id: param(req, 'id'), projectId}, select: {type: true}});
  if (template && template.type !== TemplateType.MARKETING) {
    throw refuse('the template is not a marketing template');
  }
}

/** A marketing template that no workflow sends. */
async function idleTemplate(req: Request, projectId: string): Promise<void> {
  await marketingTemplate(req, projectId);
  if (await prisma.workflowStep.count({where: {templateId: param(req, 'id'), workflow: {projectId}}})) {
    throw refuse('a workflow sends the template');
  }
}

/**
 * A segment no scheduled or sending campaign uses, directly or in its filter, and that no other segment's filter
 * names (which a campaign could use in turn).
 */
async function idleSegment(req: Request, projectId: string): Promise<void> {
  const id = param(req, 'id');
  const named = `%segment.${id}%`;
  const [usage] = await prisma.$queryRaw<{used: boolean}[]>`
    SELECT EXISTS (
      SELECT 1 FROM campaigns
      WHERE "projectId" = ${projectId} AND status::text IN ('SCHEDULED', 'SENDING')
        AND ("segmentId" = ${id} OR "audienceCondition"::text LIKE ${named})
    ) OR EXISTS (
      SELECT 1 FROM segments WHERE "projectId" = ${projectId} AND id <> ${id} AND condition::text LIKE ${named}
    ) AS used
  `;
  if (usage?.used) {
    throw refuse('a scheduled or sending campaign, or another segment, uses the segment');
  }
}

/**
 * A new layout, or one that is not the project's default and that no live send uses: no template other than a
 * marketing one outside workflows, and no scheduled or sending campaign.
 */
async function idleLayout(req: Request, projectId: string): Promise<void> {
  const layout = await prisma.layout.findUnique({
    where: {projectId_slug: {projectId, slug: param(req, 'slug')}},
    select: {id: true, isDefault: true},
  });
  if (!layout) {
    return;
  }
  if (layout.isDefault) {
    throw refuse('the layout is the project default');
  }
  const [templates, campaigns] = await Promise.all([
    prisma.template.count({
      where: {
        layoutId: layout.id,
        OR: [{type: {not: TemplateType.MARKETING}}, {workflowSteps: {some: {}}}],
      },
    }),
    prisma.campaign.count({where: {layoutId: layout.id, status: {in: LIVE_CAMPAIGN_STATUSES}}}),
  ]);
  if (templates || campaigns) {
    throw refuse('a live send uses the layout');
  }
}

const ROUTES: Record<string, Partial<Record<ApiKeyScope, Grant>>> = {
  'GET /campaigns': {draft: true},
  'POST /campaigns': {draft: marketingBody},
  'GET /campaigns/:id': {draft: true},
  'PUT /campaigns/:id': {draft: draftCampaign},
  'DELETE /campaigns/:id': {draft: draftCampaign},
  'POST /campaigns/:id/duplicate': {draft: marketingCampaign},
  'POST /campaigns/:id/test': {draft: true},
  'GET /campaigns/:id/stats': {draft: true},

  'GET /templates': {draft: true},
  'POST /templates': {draft: marketingBody},
  'GET /templates/:id': {draft: true},
  'PATCH /templates/:id': {draft: idleTemplate},
  'DELETE /templates/:id': {draft: idleTemplate},
  'POST /templates/:id/duplicate': {draft: marketingTemplate},
  'GET /templates/:id/usage': {draft: true},

  'GET /segments': {draft: true},
  'POST /segments': {draft: true},
  'GET /segments/:id': {draft: true},
  'PATCH /segments/:id': {draft: idleSegment},
  'DELETE /segments/:id': {draft: idleSegment},

  'GET /layouts': {draft: true, sync: true},
  'GET /layouts/:slug': {draft: true, sync: true},
  'PUT /layouts/:slug': {draft: idleLayout, sync: true},
  'DELETE /layouts/:slug': {draft: idleLayout, sync: true},

  'GET /topics': {draft: true, sync: true},
  'PUT /topics/:slug': {sync: true},
  'DELETE /topics/:slug': {sync: true},

  'GET /contacts/fields': {draft: true},
  'POST /contacts/batch': {sync: true},
  'POST /contacts/lookup': {sync: true},
  'DELETE /contacts/:id': {sync: true},
  'GET /contacts/:id/topics': {sync: true},
  'PUT /contacts/:id/topics': {sync: true},

  'POST /v1/emails/:id/unsubscribed': {sync: true},
};

/** The route a request matched, as the table above names it: `PUT /campaigns/:id`. */
export function routeKey(req: Request): string {
  const route = (req.route as {path?: string} | undefined)?.path ?? '';
  return `${req.method} ${`${req.baseUrl}${route}`.replace(/\/+$/, '')}`;
}

/** Lets a scoped key's request through when one of its scopes grants the route, and refuses it otherwise. */
export async function assertScopedRoute(req: Request, projectId: string, scopes: readonly string[]): Promise<void> {
  const grants = ROUTES[routeKey(req)] ?? {};
  let refusal: unknown;
  for (const scope of scopes) {
    const grant = grants[scope as ApiKeyScope];
    if (grant === true) {
      return;
    }
    if (grant) {
      try {
        await grant(req, projectId);
        return;
      } catch (error) {
        refusal ??= error;
      }
    }
  }
  throw refusal ?? refuse(`its scopes (${scopes.join(', ')}) don't include ${routeKey(req)}`);
}
