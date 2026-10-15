import {CampaignStatus} from '@plunk/db';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {CampaignService} from '../CampaignService';
import {LayoutService} from '../LayoutService';
import {TopicService} from '../TopicService';

const ses = vi.hoisted(() => ({sendRawEmail: vi.fn()}));

// The message is assembled for real; only the hand-off to SES is faked.
vi.mock('../SESService.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../SESService.js')>()),
  sendRawEmail: ses.sendRawEmail,
}));

interface SentMessage {
  to: string[];
  content: {subject: string; html: string};
  headers: Record<string, string>;
  tracking: boolean;
}

/** Rendered test sends (D35). */
describe('campaign test sends', () => {
  const prisma = getPrismaClient();
  let projectId: string;
  let member: string;

  beforeEach(async () => {
    ses.sendRawEmail.mockReset().mockResolvedValue({messageId: 'test'});
    const {user, project} = await factories.createUserWithProject();
    projectId = project.id;
    member = user.email;
    await factories.createDomain({projectId, domain: 'example.com', verified: true});
  });

  const sent = () => ses.sendRawEmail.mock.calls[0]![0] as SentMessage;

  async function campaign(data: {subject?: string; body?: string; layoutId?: string; topicId?: string}) {
    const created = await factories.createCampaign({projectId, from: 'news@example.com'});
    return prisma.campaign.update({where: {id: created.id}, data});
  }

  it("renders as the member's own contact, in the layout, with the footer and the list headers", async () => {
    await prisma.project.update({where: {id: projectId}, data: {topicsEnabled: true}});
    const news = (await TopicService.upsert(projectId, 'news', {name: 'News', listId: 'News <news.example.com>'})).topic;
    const layout = (
      await LayoutService.upsert(projectId, 'brand', {
        name: 'Brand',
        html: '<html><head></head><body><div class="content">{{ content }}</div></body></html>',
        css: '.content{color:#123456}',
      })
    ).layout;
    await factories.createContact({projectId, email: member, data: {firstName: 'Ada'}});
    const test = await campaign({
      subject: 'Hi {{ firstName }}',
      body: '<p>Hello {{ data.firstName }}</p>',
      layoutId: layout.id,
      topicId: news.id,
    });

    await CampaignService.sendTest(projectId, test.id, member);

    const message = sent();
    expect(message.to).toEqual([member]);
    expect(message.content.subject).toBe('[TEST] Hi Ada');
    expect(message.content.html).toContain('<div class="content" style="color: #123456;"><p>Hello Ada</p></div>');
    expect(message.content.html).toContain('update your preferences');
    expect(message.headers).toMatchObject({'List-Id': 'News <news.example.com>', 'X-Plunk-Test': 'true'});
    expect(message.headers['List-Unsubscribe']).toMatch(/\/unsubscribe\//);
    expect(message.tracking).toBe(false);
    // Nothing is recorded.
    expect(await prisma.email.count({where: {projectId}})).toBe(0);
  });

  it('renders as a chosen contact, of this project only', async () => {
    const ada = await factories.createContact({projectId, email: 'ada@example.org', data: {firstName: 'Ada'}});
    const {project: other} = await factories.createUserWithProject();
    const foreign = await factories.createContact({projectId: other.id, email: 'eve@example.org'});
    const test = await campaign({subject: 'For {{ email }}', body: '<p>{{ firstName }}</p>'});

    await CampaignService.sendTest(projectId, test.id, member, ada.id);
    expect(sent().content.subject).toBe('[TEST] For ada@example.org');

    await expect(CampaignService.sendTest(projectId, test.id, member, foreign.id)).rejects.toThrow('Contact not found');
  });

  it("renders with sample data when the member has no contact, and refuses who isn't a member", async () => {
    const test = await campaign({subject: 'For {{ email }}', body: '<p>Hi {{ firstName ?? there }}</p>'});

    await CampaignService.sendTest(projectId, test.id, member);
    expect(sent().content.subject).toBe(`[TEST] For ${member}`);
    expect(sent().content.html).toContain('<p>Hi there</p>');

    await expect(CampaignService.sendTest(projectId, test.id, 'stranger@example.org')).rejects.toThrow(
      'project members',
    );
  });

  it('says so when the unsubscribe URL template renders no URL for the contact', async () => {
    await prisma.project.update({where: {id: projectId}, data: {unsubscribeUrlTemplate: '{{ data.unsubscribe }}'}});
    const test = await campaign({});

    await expect(CampaignService.sendTest(projectId, test.id, member)).rejects.toThrow('renders no http(s) URL');
    expect(ses.sendRawEmail).not.toHaveBeenCalled();
  });

  it('leaves the campaign as it is', async () => {
    const test = await campaign({});
    await CampaignService.sendTest(projectId, test.id, member);
    expect((await prisma.campaign.findUniqueOrThrow({where: {id: test.id}})).status).toBe(CampaignStatus.DRAFT);
  });
});
