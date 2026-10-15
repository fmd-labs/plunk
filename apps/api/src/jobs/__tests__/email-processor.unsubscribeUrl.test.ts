import {CampaignStatus, EmailSourceType, EmailStatus} from '@plunk/db';
import type {SendEmailJobData} from '@plunk/types';
import type {Job} from 'bullmq';
import {simpleParser} from 'mailparser';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {TopicService} from '../../services/TopicService.js';
import {processEmailJob} from '../email-processor';

const sesMocks = vi.hoisted(() => ({
  getSendingQuota: vi.fn(),
  submitRawEmail: vi.fn(),
}));

// Messages are built for real; only the submission to SES is faked.
vi.mock('../../services/SESService.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../../services/SESService.js')>()),
  ...sesMocks,
}));

vi.mock('../../services/MeterService.js', () => ({
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

/** The project's unsubscribe URL template (D33) in the worker: the footer link and the List-Unsubscribe pair. */
describe('email processor with an unsubscribe URL template', () => {
  const prisma = getPrismaClient();
  let projectId: string;

  beforeEach(async () => {
    sesMocks.submitRawEmail.mockReset().mockResolvedValue({messageId: 'ses-message-id'});
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
    await prisma.project.update({
      where: {id: projectId},
      data: {topicsEnabled: true, unsubscribeUrlTemplate: '{{ data.unsubscribe[topic.slug] }}&e={{ emailId }}'},
    });
    await TopicService.upsert(projectId, 'news', {name: 'Product news'});
  });

  async function newsEmail(data: Record<string, unknown>) {
    const contact = await factories.createContact({projectId, data});
    const campaign = await factories.createCampaign({projectId, status: CampaignStatus.SENDING});
    const news = await TopicService.get(projectId, 'news');
    await prisma.campaign.update({where: {id: campaign.id}, data: {topicId: news.id}});
    return factories.createEmail({
      projectId,
      contactId: contact.id,
      campaignId: campaign.id,
      sourceType: EmailSourceType.CAMPAIGN,
      status: EmailStatus.PENDING,
      body: '<p>Hello</p>',
    });
  }

  it('points the footer and List-Unsubscribe at the URL the template renders for the email', async () => {
    const email = await newsEmail({unsubscribe: {news: 'https://example.com/u?t=abc'}});

    await processEmailJob(job(email.id));

    const [submitted] = sesMocks.submitRawEmail.mock.calls[0] as [{mime: string}];
    const message = await simpleParser(submitted.mime);
    const url = `https://example.com/u?t=abc&e=${email.id}`;
    // mailparser folds List-* headers into one object, so read the raw lines.
    const header = (name: string) =>
      message.headerLines.find(line => line.key === name)?.line.replace(/\r?\n\s+/g, ' ');
    expect(header('list-unsubscribe')).toBe(`List-Unsubscribe: <${url}>`);
    expect(header('list-unsubscribe-post')).toBe('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
    expect(message.html).toContain(`href="${url.replace('&', '&amp;')}"`);
    expect(message.html).not.toContain('/unsubscribe/');
  });

  it('fails a marketing email the template renders no URL for, without sending it', async () => {
    const email = await newsEmail({});

    await processEmailJob(job(email.id));

    expect(sesMocks.submitRawEmail).not.toHaveBeenCalled();
    const stored = await prisma.email.findUniqueOrThrow({where: {id: email.id}});
    expect(stored.status).toBe(EmailStatus.FAILED);
    expect(stored.error).toContain('unsubscribe URL template');
  });
});
