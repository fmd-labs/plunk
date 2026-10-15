import {CampaignStatus, TemplateType} from '@plunk/db';
import type {SendEmailJobData} from '@plunk/types';
import type {Job} from 'bullmq';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {processEmailJob} from '../../jobs/email-processor';
import {CampaignService} from '../CampaignService';
import {LayoutService} from '../LayoutService';
import {TopicService} from '../TopicService';

const ses = vi.hoisted(() => ({
  sendRawEmail: vi.fn(),
  submitRawEmail: vi.fn(),
  buildRawEmail: vi.fn(),
  getSendingQuota: vi.fn(),
}));

// Messages are built for real; the worker's message is read where it is built, the test's where it is sent.
vi.mock('../SESService.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../SESService.js')>();
  ses.buildRawEmail.mockImplementation(actual.buildRawEmail);
  return {...actual, ...ses};
});

vi.mock('../MeterService.js', () => ({
  MeterService: {recordEmailSent: vi.fn().mockResolvedValue(undefined)},
}));

function job(emailId: string) {
  return {
    id: `email-${emailId}`,
    data: {emailId} as SendEmailJobData,
    attemptsMade: 0,
    attemptsStarted: 1,
    priority: 1,
    opts: {attempts: 3},
    updateData: vi.fn(async () => undefined),
    changePriority: vi.fn(async () => undefined),
    moveToDelayed: vi.fn(async () => undefined),
    retry: vi.fn(async () => undefined),
  } as unknown as Job<SendEmailJobData>;
}

interface Message {
  content: {subject: string; html: string};
  headers: Record<string, string>;
}

/**
 * A test send (D35) is the email the member's own contact really gets: the same HTML and headers as the
 * worker's message for that contact, but for the email's id, the `[TEST]` subject and `X-Plunk-Test`.
 */
describe('test sends match real sends', () => {
  const prisma = getPrismaClient();
  let projectId: string;
  let member: string;

  beforeEach(async () => {
    ses.sendRawEmail.mockReset().mockResolvedValue({messageId: 'test'});
    ses.submitRawEmail.mockReset().mockResolvedValue({messageId: 'ses-real'});
    ses.buildRawEmail.mockClear();
    ses.getSendingQuota.mockReset().mockResolvedValue({max24HourSend: 100000, maxSendRate: 100, sentLast24Hours: 0});
    const {user, project} = await factories.createUserWithProject();
    projectId = project.id;
    member = user.email;
    await factories.createDomain({projectId, domain: 'example.com', verified: true});
  });

  async function compare(options: {
    project?: {escapeVariables?: boolean; unsubscribeUrlTemplate?: string};
    type?: TemplateType;
    layoutHtml?: string;
    body: string;
    topic?: boolean;
  }) {
    if (options.project) {
      await prisma.project.update({where: {id: projectId}, data: options.project});
    }
    let topicId: string | undefined;
    if (options.topic) {
      await prisma.project.update({where: {id: projectId}, data: {topicsEnabled: true}});
      topicId = (await TopicService.upsert(projectId, 'news', {name: 'News', listId: 'News <news.example.com>'})).topic
        .id;
    }
    const layoutId = options.layoutHtml
      ? (
          await LayoutService.upsert(projectId, 'brand', {
            name: 'Brand',
            html: options.layoutHtml,
            css: '.content{color:#123456}',
          })
        ).layout.id
      : undefined;
    const contact = await factories.createContact({
      projectId,
      email: member,
      data: {firstName: 'Ada <b>', token: 'tok'},
    });
    const created = await factories.createCampaign({projectId, from: 'news@example.com', type: options.type});
    const campaign = await prisma.campaign.update({
      where: {id: created.id},
      data: {subject: 'Hi {{ firstName }}', body: options.body, layoutId, topicId},
    });

    await CampaignService.sendTest(projectId, campaign.id, member);
    const test = ses.sendRawEmail.mock.calls[0]![0] as Message;

    await prisma.campaign.update({where: {id: campaign.id}, data: {status: CampaignStatus.SENDING}});
    await CampaignService.processBatch(campaign.id, 1, 0, 100);
    const email = await prisma.email.findFirstOrThrow({where: {campaignId: campaign.id, contactId: contact.id}});
    await processEmailJob(job(email.id));
    const real = ses.buildRawEmail.mock.calls.at(-1)![0] as Message;

    const testId = /[?&]e=([0-9a-f-]{36})/.exec(test.content.html + JSON.stringify(test.headers))?.[1];
    const normalize = (text: string, id?: string) => (id ? text.replaceAll(id, 'EMAIL') : text);
    const {['X-Plunk-Test']: marker, ...testHeaders} = test.headers;

    expect(marker).toBe('true');
    expect(test.content.subject).toBe(`[TEST] ${real.content.subject}`);
    expect(normalize(test.content.html, testId)).toBe(normalize(real.content.html, email.id));
    expect(normalize(JSON.stringify(testHeaders), testId)).toBe(normalize(JSON.stringify(real.headers), email.id));
  }

  it('for marketing in a topic and a layout, with escaped variables', () =>
    compare({
      project: {escapeVariables: true},
      topic: true,
      layoutHtml: '<html><head></head><body><div class="content">{{ content }}</div></body></html>',
      body: '<p>Hello {{ data.firstName }} <a href="{{ manageUrl }}">prefs</a></p>',
    }));

  it("with an unsubscribe URL template and a layout's own unsubscribe link", () =>
    compare({
      project: {unsubscribeUrlTemplate: 'https://example.org/u?t={{ data.token }}&e={{ emailId }}'},
      layoutHtml:
        '<html><head></head><body><div class="content">{{ content }}</div><a href="{{ unsubscribeUrl }}">Leave</a></body></html>',
      body: '<p>Hello</p>',
    }));

  it('for transactional with an unsubscribe link in the body', () =>
    compare({type: TemplateType.TRANSACTIONAL, body: '<p>Receipt <a href="{{ unsubscribeUrl }}">x</a></p>'}));

  it('for headless', () => compare({type: TemplateType.HEADLESS, body: '<html><body><p>Raw</p></body></html>'}));
});
