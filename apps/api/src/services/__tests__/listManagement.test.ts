import {CampaignStatus, EmailSourceType, EmailStatus, TopicBasis} from '@plunk/db';
import type {Request, Response} from 'express';
import {beforeEach, describe, expect, it} from 'vitest';

import {factories, getPrismaClient} from '../../../../../test/helpers';
import {API_URI, DASHBOARD_URI} from '../../app/constants';
import {Contacts} from '../../controllers/Contacts';
import {Unsubscribe} from '../../controllers/Unsubscribe';
import {HttpException} from '../../exceptions';
import {ListManagementService} from '../ListManagementService';
import {linkVariables, listManagementUrls} from '../ListManagementUrls';
import {TopicService} from '../TopicService';

/** List management (D33): topic-aware unsubscribes, the unsubscribe URL template and the report-back. */

/** Settles on what a controller handler sent: `CatchAsync` does not return the handler's promise. */
function call(
  handler: (req: Request, res: Response, next: (error?: unknown) => void) => unknown,
  req: Partial<Request>,
) {
  return new Promise<{status: number; body?: unknown; location?: string; error?: unknown}>(resolve => {
    let status = 200;
    const res = {
      status(code: number) {
        status = code;
        return this;
      },
      type() {
        return this;
      },
      json(body: unknown) {
        resolve({status, body});
        return this;
      },
      send(body: unknown) {
        resolve({status, body});
        return this;
      },
      redirect(code: number, location: string) {
        resolve({status: code, location});
        return this;
      },
    } as unknown as Response;
    void handler({params: {}, query: {}, body: {}, ...req} as Request, res, error => resolve({status: 0, error}));
  });
}

describe('list management', () => {
  const prisma = getPrismaClient();
  let projectId: string;

  beforeEach(async () => {
    const {project} = await factories.createUserWithProject();
    projectId = project.id;
  });

  async function topicsProject() {
    await prisma.project.update({where: {id: projectId}, data: {topicsEnabled: true}});
    const news = (await TopicService.upsert(projectId, 'news', {name: 'Product news'})).topic;
    const digest = (await TopicService.upsert(projectId, 'digest', {name: 'Digest', basis: TopicBasis.OPT_IN})).topic;
    return {news, digest};
  }

  /** A campaign email to the contact, for the topic when given. */
  async function campaignEmail(contactId: string, topicId?: string) {
    const campaign = await factories.createCampaign({projectId, status: CampaignStatus.SENT});
    if (topicId) {
      await prisma.campaign.update({where: {id: campaign.id}, data: {topicId}});
    }
    const email = await factories.createEmail({
      projectId,
      contactId,
      campaignId: campaign.id,
      sourceType: EmailSourceType.CAMPAIGN,
      status: EmailStatus.SENT,
    });
    return {campaign, email};
  }

  const unsubscribedCount = async (campaignId: string) =>
    (await prisma.campaign.findUniqueOrThrow({where: {id: campaignId}})).unsubscribedCount;
  const unsubscribeEvents = (contactId: string) =>
    prisma.event.findMany({where: {contactId, name: 'contact.unsubscribed'}, orderBy: {createdAt: 'asc'}});
  const topicState = async (contactId: string, topicId: string) =>
    (await prisma.contactTopic.findUnique({where: {contactId_topicId: {contactId, topicId}}}))?.subscribed ?? null;

  describe('URLs', () => {
    const contact = {id: 'c1', email: 'ada@example.com', data: {first: 'Ada', unsubscribe: {news: 'https://example.com/u?t=abc'}}};

    it("are Plunk's pages, tagged with the email, without a template", () => {
      expect(listManagementUrls({contact, emailId: 'e1'})).toEqual({
        unsubscribeUrl: `${DASHBOARD_URI}/unsubscribe/c1?e=e1`,
        subscribeUrl: `${DASHBOARD_URI}/subscribe/c1?e=e1`,
        manageUrl: `${DASHBOARD_URI}/manage/c1?e=e1`,
        oneClickUrl: `${API_URI}/unsubscribe/c1?e=e1`,
      });
    });

    it("are the template's one URL, rendered with the contact, the email and the topic", () => {
      const urls = listManagementUrls({
        contact,
        emailId: 'e1',
        template: '{{ data.unsubscribe[topic.slug] }}&e={{ emailId }}&n={{ first | url_encode }}',
        topic: {id: 't1', slug: 'news', name: 'Product news'},
      });
      expect(urls).toEqual({
        unsubscribeUrl: 'https://example.com/u?t=abc&e=e1&n=Ada',
        subscribeUrl: 'https://example.com/u?t=abc&e=e1&n=Ada',
        manageUrl: 'https://example.com/u?t=abc&e=e1&n=Ada',
        oneClickUrl: 'https://example.com/u?t=abc&e=e1&n=Ada',
      });
    });

    it('are none when the template renders no http(s) URL', () => {
      for (const template of ['{{ data.unsubscribe[topic.slug] }}', 'mailto:{{ email }}', 'javascript:alert(1)']) {
        expect(listManagementUrls({contact, emailId: 'e1', template, topic: null})).toBeNull();
      }
      expect(linkVariables(null)).toEqual({unsubscribeUrl: '', subscribeUrl: '', manageUrl: ''});
    });

    it('cannot carry a line break or a quote into a header or an attribute', () => {
      const urls = listManagementUrls({
        contact: {id: 'c1', email: 'ada@example.com', data: {x: 'a\r\nBcc: evil@example.com"<b>'}},
        template: 'https://example.com/u?x={{ x }}',
      });
      expect(urls?.oneClickUrl).not.toMatch(/[\r\n"<>]/);
    });
  });

  describe("Plunk's one-click unsubscribe", () => {
    it('drops only the topic of a topic campaign, once', async () => {
      const {news} = await topicsProject();
      const contact = await factories.createContact({projectId, subscribed: true});
      const {campaign, email} = await campaignEmail(contact.id, news.id);

      await ListManagementService.oneClickUnsubscribe(contact.id, email.id);
      await ListManagementService.oneClickUnsubscribe(contact.id, email.id);

      expect((await prisma.contact.findUniqueOrThrow({where: {id: contact.id}})).subscribed).toBe(true);
      expect(await topicState(contact.id, news.id)).toBe(false);
      const events = await unsubscribeEvents(contact.id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({emailId: email.id, data: {topic: 'news'}});
      expect(await unsubscribedCount(campaign.id)).toBe(1);
    });

    it('unsubscribes from everything from an email without a topic', async () => {
      const contact = await factories.createContact({projectId, subscribed: true});
      const {campaign, email} = await campaignEmail(contact.id);

      await ListManagementService.oneClickUnsubscribe(contact.id, email.id);

      expect((await prisma.contact.findUniqueOrThrow({where: {id: contact.id}})).subscribed).toBe(false);
      expect(await unsubscribedCount(campaign.id)).toBe(1);
    });
  });

  describe('hosted pages', () => {
    it('show the topics and the topic of the email, and change one topic', async () => {
      const {news} = await topicsProject();
      const contact = await factories.createContact({projectId, subscribed: true});
      const {email} = await campaignEmail(contact.id, news.id);
      const contacts = new Contacts();

      const page = await call(contacts.getPublic.bind(contacts), {params: {id: contact.id}, query: {e: email.id}});
      expect(page.body).toMatchObject({
        topic: {slug: 'news', name: 'Product news', subscribed: true},
        topics: [
          {slug: 'news', subscribed: true},
          {slug: 'digest', subscribed: false},
        ],
      });

      const left = await call(contacts.unsubscribePublic.bind(contacts), {
        params: {id: contact.id},
        query: {e: email.id},
        body: {topic: 'news'},
      });
      expect(left.body).toMatchObject({subscribed: true, topic: {slug: 'news', subscribed: false}});

      const back = await call(contacts.subscribePublic.bind(contacts), {
        params: {id: contact.id},
        query: {e: email.id},
        body: {topic: 'news'},
      });
      expect(back.body).toMatchObject({topic: {slug: 'news', subscribed: true}});
      expect((await prisma.event.findMany({where: {contactId: contact.id}})).map(event => event.name).sort()).toEqual([
        'contact.subscribed',
        'contact.unsubscribed',
      ]);
    });

    it('refuse a topic without topics', async () => {
      const contact = await factories.createContact({projectId, subscribed: true});
      await expect(ListManagementService.setPublicTopic(contact.id, 'news', false)).rejects.toThrow('was not found');
    });
  });

  describe('with an unsubscribe URL template', () => {
    const template = 'https://example.com/unsubscribe?c={{ id }}{% if topic %}&t={{ topic.slug }}{% endif %}&e={{ emailId }}';

    it("turn Plunk's public contact routes off, as for an unknown contact", async () => {
      const contact = await factories.createContact({projectId, subscribed: true});
      await prisma.project.update({where: {id: projectId}, data: {unsubscribeUrlTemplate: template}});
      const contacts = new Contacts();

      for (const handler of [contacts.getPublic, contacts.unsubscribePublic, contacts.subscribePublic, contacts.snoozePublic]) {
        const result = await call(handler.bind(contacts), {params: {id: contact.id}, body: {duration: '2_weeks'}});
        expect(result.error).toBeInstanceOf(HttpException);
        expect((result.error as HttpException).code).toBe(404);
        expect((result.error as HttpException).message).toBe('Contact not found');
      }
      expect((await prisma.contact.findUniqueOrThrow({where: {id: contact.id}})).subscribed).toBe(true);
    });

    it('forward the links of older mail to the URL the template renders for that email', async () => {
      const {news} = await topicsProject();
      const contact = await factories.createContact({projectId, subscribed: true});
      const {email} = await campaignEmail(contact.id, news.id);
      await prisma.project.update({where: {id: projectId}, data: {unsubscribeUrlTemplate: template}});
      const unsubscribe = new Unsubscribe();
      const expected = `https://example.com/unsubscribe?c=${contact.id}&t=news&e=${email.id}`;

      const get = await call(unsubscribe.redirect.bind(unsubscribe), {params: {id: contact.id}, query: {e: email.id}});
      expect(get).toEqual({status: 302, location: expected});

      const post = await call(unsubscribe.oneClick.bind(unsubscribe), {params: {id: contact.id}, query: {e: email.id}});
      expect(post).toEqual({status: 307, location: expected});
      expect(await topicState(contact.id, news.id)).toBeNull();

      await prisma.project.update({
        where: {id: projectId},
        data: {unsubscribeUrlTemplate: '{{ data.missing }}'},
      });
      const gone = await call(unsubscribe.oneClick.bind(unsubscribe), {params: {id: contact.id}, query: {e: email.id}});
      expect(gone.status).toBe(404);
    });
  });

  describe('the report-back', () => {
    it("drops the email's topic, and counts once however often it is reported", async () => {
      const {news} = await topicsProject();
      const contact = await factories.createContact({projectId, subscribed: true, email: 'ada@example.com'});
      const {campaign, email} = await campaignEmail(contact.id, news.id);

      // The sender's own sync dropped the topic already: the report still counts.
      await TopicService.setContactStates(projectId, contact.id, {news: false});

      const first = await ListManagementService.reportUnsubscribe(projectId, email.id, {email: 'ADA@example.com'});
      const again = await ListManagementService.reportUnsubscribe(projectId, email.id, {});

      expect(first).toEqual({contactId: contact.id, topic: 'news', counted: true});
      expect(again).toEqual({contactId: contact.id, topic: 'news', counted: false});
      expect(await topicState(contact.id, news.id)).toBe(false);
      expect((await prisma.contact.findUniqueOrThrow({where: {id: contact.id}})).subscribed).toBe(true);
      expect(await unsubscribeEvents(contact.id)).toHaveLength(1);
      expect(await unsubscribedCount(campaign.id)).toBe(1);
    });

    it('unsubscribes from another topic, or from everything', async () => {
      const {news, digest} = await topicsProject();
      const contact = await factories.createContact({projectId, subscribed: true});
      const first = await campaignEmail(contact.id, news.id);
      const second = await campaignEmail(contact.id, news.id);

      await ListManagementService.reportUnsubscribe(projectId, first.email.id, {topic: 'digest'});
      expect(await topicState(contact.id, digest.id)).toBe(false);
      expect(await topicState(contact.id, news.id)).toBeNull();

      await ListManagementService.reportUnsubscribe(projectId, second.email.id, {topic: null});
      expect((await prisma.contact.findUniqueOrThrow({where: {id: contact.id}})).subscribed).toBe(false);
    });

    it("refuses another address, another project's email, an unknown topic, and a topic without topics", async () => {
      const contact = await factories.createContact({projectId, subscribed: true, email: 'ada@example.com'});
      const {email} = await campaignEmail(contact.id);
      const {project: other} = await factories.createUserWithProject();

      await expect(ListManagementService.reportUnsubscribe(projectId, email.id, {email: 'bob@example.com'})).rejects.toThrow(
        'another address',
      );
      await expect(ListManagementService.reportUnsubscribe(other.id, email.id, {})).rejects.toThrow('was not found');
      await expect(ListManagementService.reportUnsubscribe(projectId, email.id, {topic: 'news'})).rejects.toThrow(
        'Topics are not enabled',
      );
      await topicsProject();
      await expect(ListManagementService.reportUnsubscribe(projectId, email.id, {topic: 'nope'})).rejects.toThrow(
        'was not found',
      );
      expect((await prisma.contact.findUniqueOrThrow({where: {id: contact.id}})).subscribed).toBe(true);
    });

    it('does not count a bounced email against its campaign', async () => {
      const contact = await factories.createContact({projectId, subscribed: true});
      const {campaign, email} = await campaignEmail(contact.id);
      await prisma.email.update({where: {id: email.id}, data: {bouncedAt: new Date()}});

      expect(await ListManagementService.reportUnsubscribe(projectId, email.id, {})).toMatchObject({counted: true});
      expect(await unsubscribedCount(campaign.id)).toBe(0);
    });
  });
});
