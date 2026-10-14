import {CampaignStatus, TemplateType, TopicBasis, WorkflowStepType} from '@plunk/db';
import type {Request, Response} from 'express';
import {beforeEach, describe, expect, it} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {Actions} from '../../controllers/Actions';
import {HttpException} from '../../exceptions';
import {CampaignService} from '../CampaignService';
import {ContactService} from '../ContactService';
import {SegmentService} from '../SegmentService';
import {TopicService} from '../TopicService';
import {WorkflowExecutionService} from '../WorkflowExecutionService';
import {WorkflowService} from '../WorkflowService';

/** Topics (D32). */
describe('topics', () => {
  const prisma = getPrismaClient();
  let projectId: string;

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
    await prisma.project.update({where: {id: projectId}, data: {topicsEnabled: true}});
  });

  const topic = (
    slug: string,
    basis: TopicBasis = TopicBasis.OPT_OUT,
    extra: {listId?: string; campaignSelectable?: boolean} = {},
  ) => TopicService.upsert(projectId, slug, {name: slug, basis, ...extra}).then(result => result.topic);

  async function contact(
    email: string,
    {subscribed = true, topics = {}}: {subscribed?: boolean; topics?: Record<string, boolean>} = {},
  ) {
    const created = await factories.createContact({projectId, email, subscribed});
    if (Object.keys(topics).length > 0) {
      await TopicService.setContactStates(projectId, created.id, topics);
    }
    return created;
  }

  async function recipients(campaign: {id: string}): Promise<string[]> {
    await prisma.campaign.update({where: {id: campaign.id}, data: {status: CampaignStatus.SENDING}});
    await CampaignService.processBatch(campaign.id, 1, 0, 500);
    const emails = await prisma.email.findMany({where: {campaignId: campaign.id}, include: {contact: true}});
    return emails.map(email => email.contact.email).sort();
  }

  describe('effective subscription', () => {
    it('is the explicit state, or the basis without one', async () => {
      await topic('news', TopicBasis.OPT_OUT);
      await topic('digest', TopicBasis.OPT_IN);
      const ada = await contact('ada@example.com', {topics: {digest: true}});

      expect(
        (await TopicService.contactStates(projectId, ada.id)).map(({slug, subscribed, explicit}) => ({
          slug,
          subscribed,
          explicit,
        })),
      ).toEqual([
        {slug: 'news', subscribed: true, explicit: null},
        {slug: 'digest', subscribed: true, explicit: true},
      ]);

      await TopicService.setContactStates(projectId, ada.id, {news: false, digest: null});
      expect((await TopicService.contactStates(projectId, ada.id)).map(state => state.subscribed)).toEqual([
        false,
        false,
      ]);
    });

    it('refuses a slug the project does not have', async () => {
      const ada = await contact('ada@example.com');
      await expect(TopicService.setContactStates(projectId, ada.id, {nope: true})).rejects.toBeInstanceOf(
        HttpException,
      );
    });
  });

  describe('campaigns', () => {
    it('reach only contacts subscribed to the topic, and subscribed at all', async () => {
      const news = await topic('news', TopicBasis.OPT_OUT, {listId: 'News <news.example.com>'});
      await contact('in@example.com');
      await contact('out@example.com', {topics: {news: false}});
      await contact('suppressed@example.com', {subscribed: false});
      const campaign = await factories.createCampaign({projectId});
      await prisma.campaign.update({where: {id: campaign.id}, data: {topicId: news.id}});

      expect(await recipients(campaign)).toEqual(['in@example.com']);
      const email = await prisma.email.findFirstOrThrow({where: {campaignId: campaign.id}});
      expect(email.headers).toMatchObject({'List-Id': 'News <news.example.com>'});
    });

    it('reach only explicit subscribers of an opt-in topic', async () => {
      const digest = await topic('digest', TopicBasis.OPT_IN);
      await contact('yes@example.com', {topics: {digest: true}});
      await contact('default@example.com');
      const campaign = await factories.createCampaign({projectId});
      await prisma.campaign.update({where: {id: campaign.id}, data: {topicId: digest.id}});

      expect(await recipients(campaign)).toEqual(['yes@example.com']);
    });

    it('reach nobody without a topic, with a topic campaigns cannot use, or as TRANSACTIONAL', async () => {
      const segmentsOnly = await topic('segments-only', TopicBasis.OPT_OUT, {campaignSelectable: false});
      await contact('ada@example.com');

      const withoutTopic = await factories.createCampaign({projectId});
      const unusable = await factories.createCampaign({projectId});
      await prisma.campaign.update({where: {id: unusable.id}, data: {topicId: segmentsOnly.id}});
      const transactional = await factories.createCampaign({projectId, type: TemplateType.TRANSACTIONAL});

      for (const campaign of [withoutTopic, unusable, transactional]) {
        expect(await recipients(campaign)).toEqual([]);
      }
    });

    it('cannot be sent without a topic, created as TRANSACTIONAL, or given a topic outside a topics project', async () => {
      await contact('ada@example.com');
      const campaign = await factories.createCampaign({projectId});
      await expect(CampaignService.send(projectId, campaign.id)).rejects.toThrow('Choose the topic');

      await expect(
        TopicService.assertCampaign(projectId, {type: TemplateType.TRANSACTIONAL}, {requireTopic: false}),
      ).rejects.toThrow('cannot send transactional campaigns');

      const news = await topic('news');
      await prisma.project.update({where: {id: projectId}, data: {topicsEnabled: false}});
      await expect(TopicService.assertCampaign(projectId, {topicId: news.id}, {requireTopic: false})).rejects.toThrow(
        'Topics are not enabled',
      );
    });

    it('keep upstream audiences in a project without topics', async () => {
      await prisma.project.update({where: {id: projectId}, data: {topicsEnabled: false}});
      await contact('ada@example.com');
      const campaign = await factories.createCampaign({projectId});

      expect(await recipients(campaign)).toEqual(['ada@example.com']);
    });

    it('lose their topic when it is deleted, and then reach nobody', async () => {
      const news = await topic('news');
      await contact('ada@example.com');
      const campaign = await factories.createCampaign({projectId});
      await prisma.campaign.update({where: {id: campaign.id}, data: {topicId: news.id}});

      await TopicService.delete(projectId, 'news');

      expect((await prisma.campaign.findUniqueOrThrow({where: {id: campaign.id}})).topicId).toBeNull();
      expect(await recipients(campaign)).toEqual([]);
    });
  });

  describe('segments', () => {
    it('filter on the effective subscription to a topic', async () => {
      const news = await topic('news');
      await contact('in@example.com');
      await contact('out@example.com', {topics: {news: false}});

      for (const [operator, value, expected] of [
        ['equals', true, ['in@example.com']],
        ['equals', false, ['out@example.com']],
        ['notEquals', true, ['out@example.com']],
      ] as const) {
        const segment = await factories.createSegment(projectId, {
          filters: [{field: `topic.${news.id}`, operator, value}],
        });
        const result = await SegmentService.getContacts(projectId, segment.id, 1, 100);
        expect(result.data.map((member: {email: string}) => member.email).sort()).toEqual(expected);
      }
    });

    it('refuse a topic filter that is not a yes/no comparison', async () => {
      const news = await topic('news');
      await expect(
        SegmentService.create(projectId, {
          name: 'Invalid',
          condition: {
            logic: 'AND',
            groups: [{filters: [{field: `topic.${news.id}`, operator: 'contains', value: 'x'}]}],
          },
        }),
      ).rejects.toBeInstanceOf(HttpException);
    });
  });

  describe('contacts', () => {
    it('take topic states from a batch upsert', async () => {
      await topic('news');
      await topic('digest', TopicBasis.OPT_IN);

      const [ada] = await ContactService.upsertMany(projectId, [
        {email: 'ada@example.com', topics: {news: false, digest: true}},
      ]);

      expect((await TopicService.contactStates(projectId, ada!.id)).map(state => state.subscribed)).toEqual([
        false,
        true,
      ]);
      await expect(
        ContactService.upsertMany(projectId, [{email: 'bob@example.com', topics: {unknown: true}}]),
      ).rejects.toBeInstanceOf(HttpException);
      expect(await prisma.contact.count({where: {projectId, email: 'bob@example.com'}})).toBe(0);
    });

    it('are created subscribed by a transactional send in a topics project', async () => {
      await factories.createDomain({projectId, domain: 'example.com', verified: true});
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

      await send({to: 'new@example.org', subject: 'Hi', body: '<p>Hi</p>', from: 'hello@example.com'});
      expect((await prisma.contact.findFirstOrThrow({where: {projectId, email: 'new@example.org'}})).subscribed).toBe(
        true,
      );

      await prisma.project.update({where: {id: projectId}, data: {topicsEnabled: false}});
      await send({to: 'other@example.org', subject: 'Hi', body: '<p>Hi</p>', from: 'hello@example.com'});
      expect((await prisma.contact.findFirstOrThrow({where: {projectId, email: 'other@example.org'}})).subscribed).toBe(
        false,
      );
    });
  });

  describe('workflows', () => {
    async function marketingWorkflow() {
      const template = await factories.createTemplate({projectId, type: TemplateType.MARKETING});
      return factories.createWorkflowWithSteps(projectId, [
        {type: WorkflowStepType.SEND_EMAIL, templateId: template.id},
      ]);
    }

    it('cannot be enabled with a marketing send step', async () => {
      const {workflow} = await marketingWorkflow();

      await expect(WorkflowService.update(projectId, workflow.id, {enabled: true})).rejects.toThrow(
        'sends a marketing template',
      );
    });

    it('refuse a marketing send step however they were enabled', async () => {
      const {workflow, steps} = await marketingWorkflow();
      const ada = await contact('ada@example.com');
      const execution = await factories.createWorkflowExecution(workflow.id, ada.id);

      await WorkflowExecutionService.processStepExecution(execution.id, steps[0]!.id).catch(() => undefined);

      expect(await prisma.email.count({where: {workflowExecutionId: execution.id}})).toBe(0);
    });
  });
});
