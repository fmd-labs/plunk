import {type Topic, TopicBasis} from '@plunk/db';

import {prisma} from '../database/prisma.js';
import {ErrorCode, HttpException, NotFound} from '../exceptions/index.js';
import {ContactService, type SourceEmail} from './ContactService.js';
import {EventService} from './EventService.js';
import {listManagementUrls} from './ListManagementUrls.js';
import {TopicService} from './TopicService.js';

/**
 * Recipient-driven subscription changes beyond upstream's single `subscribed` flag (fork D33):
 *
 * - In a project with topics, an unsubscribe from a campaign's email drops that campaign's topic only,
 *   through Plunk's one-click endpoint and its hosted pages alike.
 * - A project with its own unsubscribe page (an unsubscribe URL template, see `ListManagementUrls`)
 *   turns Plunk's hosted pages and public contact routes off, and reports the unsubscribes its page
 *   took back to Plunk, so that they are counted against the email's campaign.
 */

/** A topic as the hosted pages show it to a recipient. */
export interface PublicTopic {
  slug: string;
  name: string;
  description: string | null;
  subscribed: boolean;
}

/** Where a request to Plunk's public unsubscribe routes goes. */
export type HostedRoute =
  /** Plunk's own pages are on. */
  | {kind: 'plunk'}
  /** The project has its own page: the URL its template renders for this contact and email, if any. */
  | {kind: 'sender'; url: string | null};

/** What a sender reports with an unsubscribe from one of its emails. */
export interface UnsubscribeReport {
  /** The topic the recipient left by slug, `null` for every email, absent for the email's own topic. */
  topic?: string | null;
  /** The recipient's address, checked against the email's when given. */
  email?: string;
}

export interface UnsubscribeReportResult {
  contactId: string;
  /** The topic the contact was unsubscribed from, `null` for every email. */
  topic: string | null;
  /** Whether this report counted: an email counts one unsubscribe, however often it is reported. */
  counted: boolean;
}

export class ListManagementService {
  /**
   * Set a contact's explicit state for one topic, on the recipient's behalf. A change from the
   * effective state tracks `contact.subscribed` or `contact.unsubscribed` with the topic's slug as
   * `topic`, attributed to the email the recipient acted from, and an unsubscribe of a contact who
   * was receiving the topic counts against that email's campaign. Setting the state it already has
   * changes nothing else, so a repeated one-click or page action is harmless.
   */
  public static async setTopicSubscription(
    contactId: string,
    topic: Topic,
    subscribed: boolean,
    source?: SourceEmail,
  ): Promise<void> {
    const contact = await prisma.contact.findUnique({
      where: {id: contactId},
      select: {
        projectId: true,
        subscribed: true,
        topicStates: {where: {topicId: topic.id}, select: {subscribed: true}},
      },
    });

    if (contact?.projectId !== topic.projectId) {
      throw new NotFound('contact', contactId);
    }

    const before = contact.topicStates[0]?.subscribed ?? topic.basis === TopicBasis.OPT_OUT;

    await prisma.contactTopic.upsert({
      where: {contactId_topicId: {contactId, topicId: topic.id}},
      create: {contactId, topicId: topic.id, subscribed},
      update: {subscribed},
    });

    if (before === subscribed) {
      return;
    }

    await EventService.trackEvent(
      contact.projectId,
      subscribed ? 'contact.subscribed' : 'contact.unsubscribed',
      contactId,
      source?.id,
      {topic: topic.slug},
    );

    // Counted like `ContactService.unsubscribe` counts: not for a bounced or complained email, whose
    // stats report that instead, and only when the contact was receiving the topic at all.
    if (!subscribed && contact.subscribed && source?.campaignId && !source.suppressed) {
      await ContactService.countCampaignUnsubscribe(source.campaignId);
    }
  }

  /**
   * RFC 8058 one-click unsubscribe on Plunk's endpoint. From an email of a campaign with a topic, it
   * drops that topic; otherwise every email, as upstream does. Acts only on a change, since providers
   * retry and recipients click twice.
   */
  public static async oneClickUnsubscribe(contactId: string, emailId?: string): Promise<void> {
    const source = await ContactService.resolveSourceEmail(contactId, emailId);

    if (source?.topic) {
      await this.setTopicSubscription(contactId, source.topic, false, source);
      return;
    }

    const contact = await prisma.contact.findUnique({where: {id: contactId}, select: {subscribed: true}});
    if (contact?.subscribed) {
      await ContactService.unsubscribe(contactId, {emailId});
    }
  }

  /**
   * Where Plunk's public unsubscribe routes send a request for this contact. With the project's own
   * unsubscribe page, Plunk's are off, and a link in an email sent before the page was set is
   * forwarded to the URL the template renders for that email.
   */
  public static async hostedRoute(contactId: string, emailId?: string): Promise<HostedRoute> {
    const contact = await prisma.contact.findUnique({
      where: {id: contactId},
      select: {id: true, email: true, data: true, project: {select: {unsubscribeUrlTemplate: true}}},
    });
    const template = contact?.project.unsubscribeUrlTemplate;

    if (!contact || !template) {
      return {kind: 'plunk'};
    }

    const source = await ContactService.resolveSourceEmail(contactId, emailId);
    const urls = listManagementUrls({contact, emailId: source?.id, template, topic: source?.topic});
    return {kind: 'sender', url: urls?.oneClickUrl ?? null};
  }

  /**
   * Plunk's public contact routes, refused for a project with its own unsubscribe page: answers as
   * an unknown contact does.
   */
  public static async assertHostedPages(contactId: string): Promise<void> {
    const contact = await prisma.contact.findUnique({
      where: {id: contactId},
      select: {project: {select: {unsubscribeUrlTemplate: true}}},
    });
    if (contact?.project.unsubscribeUrlTemplate) {
      // `ContactService.getById`'s answer for an unknown contact, word for word.
      throw new HttpException(404, 'Contact not found');
    }
  }

  /**
   * The topics part of what the hosted pages show: every topic of the project with the contact's
   * effective state, and the topic of the email the recipient came from. Nothing without topics.
   */
  public static async publicTopics(
    projectId: string,
    contactId: string,
    sourceTopic: Topic | null | undefined,
  ): Promise<{topics?: PublicTopic[]; topic?: PublicTopic | null}> {
    if (!(await TopicService.enabled(projectId))) {
      return {};
    }

    const topics = (await TopicService.contactStates(projectId, contactId)).map(state => ({
      slug: state.slug,
      name: state.name,
      description: state.description,
      subscribed: state.subscribed,
    }));

    return {topics, topic: sourceTopic ? (topics.find(topic => topic.slug === sourceTopic.slug) ?? null) : null};
  }

  /**
   * A hosted page's change of one topic: `slug` of the contact's project, with topics on (404
   * otherwise, as for an unknown contact). Returns the page's new topics view.
   */
  public static async setPublicTopic(
    contactId: string,
    slug: string,
    subscribed: boolean,
    emailId?: string,
  ): Promise<{topics?: PublicTopic[]; topic?: PublicTopic | null}> {
    const contact = await ContactService.getById(contactId);
    const topic = await prisma.topic.findUnique({where: {projectId_slug: {projectId: contact.projectId, slug}}});

    if (!topic || !(await TopicService.enabled(contact.projectId))) {
      throw new NotFound('topic', slug);
    }

    const source = await ContactService.resolveSourceEmail(contactId, emailId);
    await this.setTopicSubscription(contactId, topic, subscribed, source);

    return this.publicTopics(contact.projectId, contactId, source?.topic);
  }

  /**
   * An unsubscribe a sender took on its own page, from one of the project's emails: unsubscribes the
   * contact from the topic (by default the topic of the email's campaign) or from every email, as a
   * repeat of the change the sender keeps itself. The first report of an email also tracks
   * `contact.unsubscribed` against it (with `topic` for a topic) and counts it against its campaign;
   * later ones change nothing more, so a sender can retry freely.
   */
  public static async reportUnsubscribe(
    projectId: string,
    emailId: string,
    report: UnsubscribeReport,
  ): Promise<UnsubscribeReportResult> {
    const email = await prisma.email.findFirst({
      where: {id: emailId, projectId},
      select: {id: true, contactId: true, contact: {select: {email: true}}},
    });

    // Another project's email reads as missing too: the answer must not reveal that it exists.
    if (!email) {
      throw new NotFound('email', emailId);
    }

    if (report.email !== undefined && report.email.trim().toLowerCase() !== email.contact.email.toLowerCase()) {
      throw new HttpException(400, 'This email was sent to another address', ErrorCode.VALIDATION_ERROR);
    }

    const source = (await ContactService.resolveSourceEmail(email.contactId, email.id))!;
    const topic = report.topic === undefined ? source.topic : await this.reportedTopic(projectId, report.topic);

    if (topic) {
      await prisma.contactTopic.upsert({
        where: {contactId_topicId: {contactId: email.contactId, topicId: topic.id}},
        create: {contactId: email.contactId, topicId: topic.id, subscribed: false},
        update: {subscribed: false},
      });
    } else {
      // As `ContactService.unsubscribe` does: a snooze becomes permanent.
      await prisma.contact.update({where: {id: email.contactId}, data: {subscribed: false, snoozedUntil: null}});
    }

    // Claimed with a conditional write, so two reports of one email that race each other count once.
    const claimed = await prisma.email.updateMany({
      where: {id: email.id, unsubscribeReportedAt: null},
      data: {unsubscribeReportedAt: new Date()},
    });
    const counted = claimed.count === 1;

    if (counted) {
      await EventService.trackEvent(
        projectId,
        'contact.unsubscribed',
        email.contactId,
        email.id,
        topic ? {topic: topic.slug} : undefined,
      );
      if (source.campaignId && !source.suppressed) {
        await ContactService.countCampaignUnsubscribe(source.campaignId);
      }
    }

    return {contactId: email.contactId, topic: topic?.slug ?? null, counted};
  }

  /** The topic a report names: `null` for every email, else a topic of the project, which has topics on. */
  private static async reportedTopic(projectId: string, slug: string | null): Promise<Topic | null> {
    if (slug === null) {
      return null;
    }
    if (!(await TopicService.enabled(projectId))) {
      throw new HttpException(400, 'Topics are not enabled for this project', ErrorCode.VALIDATION_ERROR);
    }
    return TopicService.get(projectId, slug);
  }
}
