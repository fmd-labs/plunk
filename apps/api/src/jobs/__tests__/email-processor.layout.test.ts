import {CampaignStatus, EmailSourceType, EmailStatus} from '@plunk/db';
import type {SendEmailJobData} from '@plunk/types';
import {toPrismaJson} from '@plunk/types';
import type {Job} from 'bullmq';
import {simpleParser} from 'mailparser';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {LAYOUT_HEADER, TEMPLATING_HEADER} from '../../services/EmailHeaderService.js';
import {LayoutService} from '../../services/LayoutService.js';
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

/** The worker finishes an email composed in a layout (D34): CSS inlined, and the layout's own footer. */
describe('email processor with a layout', () => {
  const prisma = getPrismaClient();
  let projectId: string;

  beforeEach(async () => {
    sesMocks.submitRawEmail.mockReset().mockResolvedValue({messageId: 'ses-message-id'});
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
  });

  /** A marketing campaign email as a sender stores it: rendered in the layout, noting the layout. */
  async function emailIn(layoutHtml: string, body: string) {
    const layout = (
      await LayoutService.upsert(projectId, 'news', {name: 'News', html: layoutHtml, css: '.content{color:#123456}'})
    ).layout;
    const contact = await factories.createContact({projectId});
    const campaign = await factories.createCampaign({projectId, status: CampaignStatus.SENDING});
    const email = await factories.createEmail({
      projectId,
      contactId: contact.id,
      campaignId: campaign.id,
      sourceType: EmailSourceType.CAMPAIGN,
      status: EmailStatus.PENDING,
      body: body.replace('{{ id }}', contact.id),
    });
    await prisma.email.update({
      where: {id: email.id},
      data: {headers: toPrismaJson({[TEMPLATING_HEADER]: 'off', [LAYOUT_HEADER]: layout.id})},
    });
    return email;
  }

  async function sentHtml() {
    const [submitted] = sesMocks.submitRawEmail.mock.calls[0] as [{mime: string}];
    return (await simpleParser(submitted.mime)).html || '';
  }

  it("inlines the layout's CSS and leaves Plunk's footer out when the layout links to the unsubscribe page", async () => {
    const email = await emailIn(
      '<html><head></head><body><div class="content">{{ content }}</div><a href="{{ unsubscribeUrl }}">Leave</a></body></html>',
      '<html><head></head><body><div class="content"><p>Hi</p></div><a href="http://localhost:3000/unsubscribe/{{ id }}">Leave</a></body></html>',
    );

    await processEmailJob(job(email.id));

    const html = await sentHtml();
    expect(html).toContain('<div class="content" style="color: #123456;">');
    expect(html).not.toContain('update your preferences');
  });

  it.each([
    ['a comment', '<!-- <a href="http://localhost:3000/unsubscribe/{{ id }}">Leave</a> -->'],
    ['an Outlook-only block', '<!--[if mso]><a href="http://localhost:3000/unsubscribe/{{ id }}">Leave</a><![endif]-->'],
  ])("keeps Plunk's footer when the layout's link is hidden in %s", async (_where, hidden) => {
    const email = await emailIn(
      '<html><head></head><body><div class="content">{{ content }}</div><!-- {{ unsubscribeUrl }} --></body></html>',
      `<html><head></head><body><div class="content"><p>Hi</p></div>${hidden}</body></html>`,
    );

    await processEmailJob(job(email.id));

    expect(await sentHtml()).toContain('update your preferences');
  });

  it("keeps Plunk's footer for a layout without its own unsubscribe link", async () => {
    const email = await emailIn(
      '<html><head></head><body><div class="content">{{ content }}</div></body></html>',
      '<html><head></head><body><div class="content"><p>Hi</p></div></body></html>',
    );

    await processEmailJob(job(email.id));

    expect(await sentHtml()).toContain('update your preferences');
  });
});
