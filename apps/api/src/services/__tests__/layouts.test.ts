import {CampaignStatus, TemplateType} from '@plunk/db';
import type {Request, Response} from 'express';
import {beforeEach, describe, expect, it} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {Actions} from '../../controllers/Actions';
import {CampaignService} from '../CampaignService';
import {LAYOUT_HEADER} from '../EmailHeaderService';
import {inlineLayoutCss, LayoutService} from '../LayoutService';
import {TemplateService} from '../TemplateService';

/** Layouts (D34). */
describe('layouts', () => {
  const prisma = getPrismaClient();
  let projectId: string;

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
  });

  const layout = (slug: string, extra: {isDefault?: boolean; css?: string; html?: string} = {}) =>
    LayoutService.upsert(projectId, slug, {
      name: slug,
      html:
        extra.html ??
        `<html><head></head><body><div class="${slug}">{{ content }}</div><p>{{ email }}</p></body></html>`,
      css: extra.css,
      isDefault: extra.isDefault,
    }).then(result => result.layout);

  /** `POST /v1/send` through the controller, settling on its answer or its error. */
  const send = (body: unknown) =>
    new Promise<void>((resolve, reject) => {
      const res = {
        locals: {auth: {type: 'apiKey', projectId}},
        status() {
          return this;
        },
        json() {
          resolve();
          return this;
        },
      } as unknown as Response;
      new Actions().send({body} as unknown as Request, res, error => (error ? reject(error) : resolve()));
    });

  describe('the default', () => {
    it('is one per project, and what new templates and campaigns start with', async () => {
      const first = await layout('first', {isDefault: true});
      const second = await layout('second', {isDefault: true});

      expect((await prisma.layout.findUniqueOrThrow({where: {id: first.id}})).isDefault).toBe(false);
      expect(second.isDefault).toBe(true);

      const template = await TemplateService.create(projectId, {
        name: 'T',
        subject: 'S',
        body: '<p>x</p>',
        from: 'hello@example.com',
      });
      const none = await TemplateService.create(projectId, {
        name: 'T',
        subject: 'S',
        body: '<p>x</p>',
        from: 'hello@example.com',
        layoutId: null,
      });
      expect(template.layoutId).toBe(second.id);
      expect(none.layoutId).toBeNull();
    });

    it("refuses another project's layout", async () => {
      const {project: other} = await factories.createUserWithProject();
      const foreign = (await LayoutService.upsert(other.id, 'x', {name: 'x', html: '{{ content }}'})).layout;
      const template = await TemplateService.create(projectId, {
        name: 'T',
        subject: 'S',
        body: '<p>x</p>',
        from: 'hello@example.com',
      });

      await expect(TemplateService.update(projectId, template.id, {layoutId: foreign.id})).rejects.toThrow(
        'was not found',
      );
    });
  });

  describe('campaigns', () => {
    it("refuse another project's layout", async () => {
      const {project: other} = await factories.createUserWithProject();
      const foreign = (await LayoutService.upsert(other.id, 'x', {name: 'x', html: '{{ content }}'})).layout;
      const campaign = await factories.createCampaign({projectId});

      await expect(CampaignService.update(projectId, campaign.id, {layoutId: foreign.id})).rejects.toThrow(
        'was not found',
      );
    });
  });

  describe('changes', () => {
    it('update only the fields given, and are refused while a scheduled campaign uses the layout', async () => {
      const news = await layout('news', {css: 'p{color:red}', isDefault: true});
      const renamed = (await LayoutService.upsert(projectId, 'news', {name: 'Renamed', html: news.html})).layout;
      expect(renamed).toMatchObject({name: 'Renamed', css: 'p{color:red}', isDefault: true});

      const campaign = await factories.createCampaign({projectId, status: CampaignStatus.SCHEDULED});
      await prisma.campaign.update({where: {id: campaign.id}, data: {layoutId: news.id}});
      await expect(LayoutService.delete(projectId, 'news')).rejects.toThrow('is in use by campaign');

      await prisma.campaign.update({where: {id: campaign.id}, data: {status: CampaignStatus.DRAFT}});
      await LayoutService.delete(projectId, 'news');
      expect((await prisma.campaign.findUniqueOrThrow({where: {id: campaign.id}})).layoutId).toBeNull();
    });
  });

  describe('sends', () => {
    it('compose a campaign body in its layout before the one template pass', async () => {
      const news = await layout('news');
      await factories.createContact({projectId, email: 'ada@example.com'});
      const campaign = await factories.createCampaign({projectId, status: CampaignStatus.SENDING});
      await prisma.campaign.update({
        where: {id: campaign.id},
        data: {layoutId: news.id, body: '<p>Hi {{ email }}</p>'},
      });

      await CampaignService.processBatch(campaign.id, 1, 0, 500);

      const email = await prisma.email.findFirstOrThrow({where: {campaignId: campaign.id}});
      expect(email.body).toContain('<div class="news"><p>Hi ada@example.com</p></div><p>ada@example.com</p>');
      expect(email.headers).toMatchObject({[LAYOUT_HEADER]: news.id});
    });

    it("compose a template's body in its layout", async () => {
      await factories.createDomain({projectId, domain: 'example.com', verified: true});
      const news = await layout('news');
      const template = await factories.createTemplate({
        projectId,
        type: TemplateType.TRANSACTIONAL,
        from: 'hello@example.com',
        body: '<p>Hi {{ email }}</p>',
      });
      await prisma.template.update({where: {id: template.id}, data: {layoutId: news.id}});

      await send({to: 'ada@example.org', template: template.id});
      // A send without a template is the caller's own HTML, in no layout.
      await send({to: 'bob@example.org', subject: 'Hi', body: '<p>Hi</p>', from: 'hello@example.com'});

      const ada = await prisma.email.findFirstOrThrow({where: {projectId, contact: {email: 'ada@example.org'}}});
      const bob = await prisma.email.findFirstOrThrow({where: {projectId, contact: {email: 'bob@example.org'}}});
      expect(ada.body).toContain('<div class="news"><p>Hi ada@example.org</p></div>');
      expect(ada.headers).toMatchObject({[LAYOUT_HEADER]: news.id});
      expect(bob.body).toBe('<p>Hi</p>');
      expect((bob.headers as Record<string, string> | null)?.[LAYOUT_HEADER]).toBeUndefined();
    });
  });

  it("inlines the layout's CSS after the default button styles, and keeps media queries", () => {
    const html =
      '<html><head><style>@media (max-width: 600px) { .x { padding: 0 } }</style></head><body>' +
      '<p class="email-button-row"><a class="email-button" href="https://example.com/?a=1&amp;b=2">Go</a></p>' +
      '</body></html>';

    const inlined = inlineLayoutCss(html, 'a.email-button{background-color:#ff0000}');

    expect(inlined).toContain('background-color: #ff0000');
    expect(inlined).toContain('display: inline-block');
    expect(inlined).toContain('@media (max-width: 600px)');
    expect(inlined).toContain('href="https://example.com/?a=1&amp;b=2"');
  });
});
