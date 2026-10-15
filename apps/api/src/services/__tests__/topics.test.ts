import {CampaignStatus, TemplateType, TopicBasis, WorkflowStepType} from '@plunk/db';
import {TopicSchemas} from '@plunk/shared';
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

    it("refuse another project's topic", async () => {
      const {project: other} = await factories.createUserWithProject();
      const foreign = await TopicService.upsert(other.id, 'news', {name: 'News'});
      await expect(
        SegmentService.create(projectId, {
          name: 'Foreign',
          condition: {
            logic: 'AND',
            groups: [{filters: [{field: `topic.${foreign.topic.id}`, operator: 'equals', value: true}]}],
          },
        }),
      ).rejects.toThrow('Referenced topic not found');
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

    it('are created subscribed by a transactional send only in a project that subscribes them', async () => {
      await factories.createDomain({projectId, domain: 'example.com', verified: true});

      await send({to: 'topics@example.org', subject: 'Hi', body: '<p>Hi</p>', from: 'hello@example.com'});
      expect(
        (await prisma.contact.findFirstOrThrow({where: {projectId, email: 'topics@example.org'}})).subscribed,
      ).toBe(false);

      await prisma.project.update({where: {id: projectId}, data: {subscribeTransactionalContacts: true}});
      await send({to: 'new@example.org', subject: 'Hi', body: '<p>Hi</p>', from: 'hello@example.com'});
      expect((await prisma.contact.findFirstOrThrow({where: {projectId, email: 'new@example.org'}})).subscribed).toBe(
        true,
      );
    });
  });

  describe('the send API', () => {
    it('refuses a template that is not transactional in a topics project', async () => {
      await factories.createDomain({projectId, domain: 'example.com', verified: true});
      for (const type of [TemplateType.MARKETING, TemplateType.HEADLESS]) {
        const template = await factories.createTemplate({projectId, type, from: 'hello@example.com'});
        await expect(send({to: 'ada@example.org', template: template.id})).rejects.toThrow('not transactional');
      }
      expect(await prisma.email.count({where: {projectId}})).toBe(0);

      const transactional = await factories.createTemplate({
        projectId,
        type: TemplateType.TRANSACTIONAL,
        from: 'hello@example.com',
      });
      await send({to: 'ada@example.org', template: transactional.id});
      expect(await prisma.email.count({where: {projectId}})).toBe(1);
    });
  });

  describe('campaign changes', () => {
    it('set, change and clear the topic of a draft', async () => {
      const news = await topic('news');
      const digest = await topic('digest');
      const campaign = await factories.createCampaign({projectId});

      expect((await CampaignService.update(projectId, campaign.id, {topicId: news.id})).topicId).toBe(news.id);
      expect((await CampaignService.update(projectId, campaign.id, {topicId: news.id})).topicId).toBe(news.id);
      expect((await CampaignService.update(projectId, campaign.id, {topicId: digest.id})).topicId).toBe(digest.id);
      expect((await CampaignService.update(projectId, campaign.id, {topicId: null})).topicId).toBeNull();
    });

    it('keep the topic of a scheduled campaign', async () => {
      const news = await topic('news');
      const campaign = await factories.createCampaign({projectId, status: CampaignStatus.SCHEDULED});
      await prisma.campaign.update({where: {id: campaign.id}, data: {topicId: news.id}});

      await expect(CampaignService.update(projectId, campaign.id, {topicId: null})).rejects.toThrow('Choose the topic');
    });

    it('send a scheduled campaign that cannot start back to draft, rather than to nobody', async () => {
      await contact('ada@example.com');
      const campaign = await factories.createCampaign({
        projectId,
        status: CampaignStatus.SCHEDULED,
        scheduledFor: new Date(Date.now() + 60_000),
      });

      await CampaignService.startSending(projectId, campaign.id);

      const after = await prisma.campaign.findUniqueOrThrow({where: {id: campaign.id}});
      expect(after.status).toBe(CampaignStatus.DRAFT);
      expect(after.scheduledFor).toBeNull();
    });
  });

  describe('turning topics off', () => {
    it('keeps a campaign with a topic limited to it, editable and sendable, but takes no new topic', async () => {
      const news = await topic('news');
      const digest = await topic('digest');
      await contact('in@example.com');
      await contact('out@example.com', {topics: {news: false}});
      const campaign = await factories.createCampaign({projectId});
      await CampaignService.update(projectId, campaign.id, {topicId: news.id});

      await prisma.project.update({where: {id: projectId}, data: {topicsEnabled: false}});

      await CampaignService.update(projectId, campaign.id, {topicId: news.id, subject: 'Still news'});
      await expect(CampaignService.update(projectId, campaign.id, {topicId: digest.id})).rejects.toThrow(
        'Topics are not enabled',
      );
      expect(await recipients(campaign)).toEqual(['in@example.com']);
    });
  });

  describe('topic changes', () => {
    it('change only the fields given', async () => {
      await TopicService.upsert(projectId, 'digest', {name: 'Digest', basis: TopicBasis.OPT_IN, campaignSelectable: false});

      const {topic: renamed, created} = await TopicService.upsert(projectId, 'digest', {name: 'Weekly digest'});

      expect(created).toBe(false);
      expect(renamed).toMatchObject({name: 'Weekly digest', basis: TopicBasis.OPT_IN, campaignSelectable: false});
    });

    it('refuse deleting a topic a scheduled campaign or a segment uses', async () => {
      const news = await topic('news');
      const campaign = await factories.createCampaign({projectId, status: CampaignStatus.SCHEDULED});
      await prisma.campaign.update({where: {id: campaign.id}, data: {topicId: news.id}});
      await expect(TopicService.delete(projectId, 'news')).rejects.toThrow('is in use by campaign');

      await prisma.campaign.delete({where: {id: campaign.id}});
      await factories.createSegment(projectId, {
        name: 'News readers',
        filters: [{field: `topic.${news.id}`, operator: 'equals', value: true}],
      });
      await expect(TopicService.delete(projectId, 'news')).rejects.toThrow('segment "News readers"');
    });

    it('take a List-Id of printable ASCII with a dotted id only', () => {
      const valid = (listId: string) => TopicSchemas.upsert.safeParse({name: 'News', listId}).success;
      expect(valid('Product news <news.example.com>')).toBe(true);
      expect(valid('<news.example.com>')).toBe(true);
      expect(valid('Neuigkeiten für dich <news.example.com>')).toBe(false);
      expect(valid('News <nodot>')).toBe(false);
      expect(valid('News\t<news.example.com>')).toBe(false);
    });
  });

  describe('pages of an audience', () => {
    it('match the same contacts with the cursor bound on topic states', async () => {
      const news = await topic('news');
      const digest = await topic('digest', TopicBasis.OPT_IN);
      for (let i = 0; i < 6; i++) {
        await contact(`c${i}@example.com`, {topics: {news: i % 2 === 0, digest: i % 3 === 0}});
      }
      const all = await prisma.contact.findMany({where: {projectId}, orderBy: {id: 'asc'}, select: {id: true}});
      const after = all[1]!.id;

      for (const t of [news, digest]) {
        const unbounded = await prisma.contact.findMany({
          where: {projectId, id: {gt: after}, ...TopicService.subscribedWhere(t)},
          orderBy: {id: 'asc'},
          select: {id: true},
        });
        const bounded = await prisma.contact.findMany({
          where: {projectId, id: {gt: after}, ...TopicService.subscribedWhere(t, after)},
          orderBy: {id: 'asc'},
          select: {id: true},
        });
        expect(bounded).toEqual(unbounded);
      }
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

    it('refuse a marketing send step added to an enabled workflow', async () => {
      const {workflow} = await factories.createWorkflowWithSteps(projectId, []);
      await prisma.workflow.update({where: {id: workflow.id}, data: {enabled: true}});
      const template = await factories.createTemplate({projectId, type: TemplateType.MARKETING});

      await expect(
        WorkflowService.addStep(projectId, workflow.id, {
          type: WorkflowStepType.SEND_EMAIL,
          name: 'Send',
          position: {x: 0, y: 0},
          config: {},
          templateId: template.id,
        }),
      ).rejects.toThrow('sends a marketing template');
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
