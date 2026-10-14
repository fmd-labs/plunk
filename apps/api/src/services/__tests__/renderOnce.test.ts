import {CampaignStatus, WorkflowStepType} from '@plunk/db';
import {beforeEach, describe, expect, it} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {DASHBOARD_URI} from '../../app/constants';
import {CampaignService} from '../CampaignService';
import {TEMPLATING_HEADER} from '../EmailHeaderService';
import {EmailService} from '../EmailService';
import {WorkflowExecutionService} from '../WorkflowExecutionService';

/**
 * Campaign and workflow emails are rendered once, when they are queued, and stored for the worker
 * to send as they are (D28); bodies are HTML-escaped for projects that escape variables (D29).
 * `/v1/send` is covered in `controllers/__tests__/Actions.send.test.ts`.
 */
describe('emails rendered once', () => {
  const prisma = getPrismaClient();
  let projectId: string;

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
  });

  const escapeVariables = () => prisma.project.update({where: {id: projectId}, data: {escapeVariables: true}});

  describe('campaigns', () => {
    async function sendBatch(subject: string, body: string, data: Record<string, unknown>) {
      const contact = await factories.createContact({projectId, subscribed: true, data});
      const campaign = await factories.createCampaign({projectId, subject, body, status: CampaignStatus.SENDING});

      await CampaignService.processBatch(campaign.id, 1, 0, 500);

      return {contact, email: await prisma.email.findFirstOrThrow({where: {campaignId: campaign.id}})};
    }

    it('stores the rendered email, marked for the worker to send as it is', async () => {
      const {email} = await sendBatch('Hi {{name}}', '<p>{{name}}</p>', {name: 'Ada'});

      expect(email).toMatchObject({subject: 'Hi Ada', body: '<p>Ada</p>'});
      expect(email.headers).toEqual({[TEMPLATING_HEADER]: 'off'});
    });

    it('keeps template code that contact data holds as text', async () => {
      const name = '{{ email }} {% if true %}yes{% endif %}';
      const {email} = await sendBatch('Hi {{name}}', '<p>{{name}}</p>', {name});

      expect(email).toMatchObject({subject: `Hi ${name}`, body: `<p>${name}</p>`});
    });

    it('attributes the subscription links to the email they are rendered into', async () => {
      const {contact, email} = await sendBatch(
        'Hi',
        '<a href="{{unsubscribeUrl}}">u</a> <a href="{{manageUrl}}">m</a> <a href="{{subscribeUrl}}">s</a>',
        {},
      );

      expect(email.body).toBe(
        `<a href="${DASHBOARD_URI}/unsubscribe/${contact.id}?e=${email.id}">u</a>` +
          ` <a href="${DASHBOARD_URI}/manage/${contact.id}?e=${email.id}">m</a>` +
          ` <a href="${DASHBOARD_URI}/subscribe/${contact.id}?e=${email.id}">s</a>`,
      );
    });

    it('leaves variables unescaped by default', async () => {
      const {email} = await sendBatch('Hi', '<p>{{name}}</p>', {name: '<b>Ada</b>'});

      expect(email.body).toBe('<p><b>Ada</b></p>');
    });

    it('escapes variables in the body, not in the subject, for a project that escapes them', async () => {
      await escapeVariables();
      const {email} = await sendBatch('Hi {{name}}', '<p>{{name}} | {{name | raw}} | {{tags}}</p>', {
        name: '<b>"A" & B</b>',
        tags: ['<x>', 'y'],
      });

      expect(email.subject).toBe('Hi <b>"A" & B</b>');
      expect(email.body).toBe(
        '<p>&lt;b&gt;&quot;A&quot; &amp; B&lt;/b&gt; | <b>"A" & B</b> | <li>&lt;x&gt;</li>\n<li>y</li></p>',
      );
    });
  });

  describe('workflows', () => {
    async function runSendStep(
      template: {subject: string; body: string},
      data: Record<string, unknown>,
      context: Record<string, unknown>,
    ) {
      const created = await factories.createTemplate({projectId, ...template});
      const {workflow, steps} = await factories.createWorkflowWithSteps(projectId, [
        {type: WorkflowStepType.SEND_EMAIL, templateId: created.id},
      ]);
      const contact = await factories.createContact({projectId, subscribed: true, data});
      const execution = await factories.createWorkflowExecution(workflow.id, contact.id, {context});

      await WorkflowExecutionService.processStepExecution(execution.id, steps[0]!.id);

      return {contact, email: await prisma.email.findFirstOrThrow({where: {workflowExecutionId: execution.id}})};
    }

    it('stores the rendered email with event and contact data, its links attributed to it', async () => {
      const {contact, email} = await runSendStep(
        {
          subject: 'Order {{event.order}}',
          body: '<p>{{event.order}} for {{name}}</p><a href="{{unsubscribeUrl}}">u</a>',
        },
        {name: '{{ id }}'},
        {order: '#1'},
      );

      expect(email.subject).toBe('Order #1');
      expect(email.body).toBe(
        `<p>#1 for {{ id }}</p><a href="${DASHBOARD_URI}/unsubscribe/${contact.id}?e=${email.id}">u</a>`,
      );
      expect(email.headers).toEqual({[TEMPLATING_HEADER]: 'off'});
    });

    it('escapes variables in the body for a project that escapes them', async () => {
      await escapeVariables();
      const {email} = await runSendStep(
        {subject: 'Order {{event.order}}', body: '<p>{{event.order}}</p>'},
        {},
        {order: '<a href="https://example.com">#1</a>'},
      );

      expect(email.subject).toBe('Order <a href="https://example.com">#1</a>');
      expect(email.body).toBe('<p>&lt;a href=&quot;https://example.com&quot;&gt;#1&lt;/a&gt;</p>');
    });
  });

  describe("the worker's pass", () => {
    it('escapes the body, not the subject, for a project that escapes variables', () => {
      const data = {value: '<i>x</i>'};

      expect(EmailService.format({subject: '{{value}}', body: '<p>{{value}}</p>', data, escapeHtml: true})).toEqual({
        subject: '<i>x</i>',
        body: '<p>&lt;i&gt;x&lt;/i&gt;</p>',
      });
      expect(EmailService.format({subject: '{{value}}', body: '<p>{{value}}</p>', data}).body).toBe('<p><i>x</i></p>');
    });
  });
});
