import {type Campaign, Prisma, type Topic, TemplateType, TopicBasis} from '@plunk/db';

import {prisma} from '../database/prisma.js';
import {ErrorCode, HttpException, NotFound} from '../exceptions/index.js';

/**
 * Topics (fork D32): a project with topics sends every campaign for one topic, and its contacts
 * subscribe to topics one by one. A contact's effective subscription to a topic is its explicit
 * state (a `ContactTopic` row), or without one the topic's basis: subscribed for `OPT_OUT`, not
 * subscribed for `OPT_IN`. `Contact.subscribed` keeps its meaning of "may receive marketing at all":
 * a campaign reaches a contact only when both hold.
 */

/** A where clause that matches no contact. */
const NOBODY: Prisma.ContactWhereInput = {id: {in: []}};

export interface TopicInput {
  name: string;
  description?: string | null;
  basis?: TopicBasis;
  campaignSelectable?: boolean;
  listId?: string | null;
}

export interface ContactTopicState {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  basis: TopicBasis;
  /** The effective subscription: the explicit state, or the basis without one. */
  subscribed: boolean;
  /** The explicit state, `null` when the contact has none and the basis decides. */
  explicit: boolean | null;
}

export class TopicService {
  public static list(projectId: string): Promise<Topic[]> {
    return prisma.topic.findMany({where: {projectId}, orderBy: {createdAt: 'asc'}});
  }

  public static async get(projectId: string, slug: string): Promise<Topic> {
    const topic = await prisma.topic.findUnique({where: {projectId_slug: {projectId, slug}}});
    if (!topic) {
      throw new NotFound('topic', slug);
    }
    return topic;
  }

  /** Create the topic with this slug, or update it. */
  public static async upsert(
    projectId: string,
    slug: string,
    input: TopicInput,
  ): Promise<{topic: Topic; created: boolean}> {
    const existing = await prisma.topic.findUnique({where: {projectId_slug: {projectId, slug}}, select: {id: true}});
    const data = {
      name: input.name,
      description: input.description ?? null,
      basis: input.basis ?? TopicBasis.OPT_OUT,
      campaignSelectable: input.campaignSelectable ?? true,
      listId: input.listId ?? null,
    };
    const topic = await prisma.topic.upsert({
      where: {projectId_slug: {projectId, slug}},
      create: {projectId, slug, ...data},
      update: data,
    });
    return {topic, created: !existing};
  }

  /** Delete a topic and every contact's state for it. Campaigns sent for it keep their stats and lose the link. */
  public static async delete(projectId: string, slug: string): Promise<void> {
    const topic = await this.get(projectId, slug);
    await prisma.topic.delete({where: {id: topic.id}});
  }

  /** The project's topics by slug, refusing a slug the project does not have. */
  public static async bySlugs(projectId: string, slugs: string[]): Promise<Map<string, Topic>> {
    const unique = [...new Set(slugs)];
    if (unique.length === 0) {
      return new Map();
    }
    const topics = await prisma.topic.findMany({where: {projectId, slug: {in: unique}}});
    const bySlug = new Map(topics.map(topic => [topic.slug, topic]));
    const missing = unique.filter(slug => !bySlug.has(slug));
    if (missing.length > 0) {
      throw new HttpException(400, `Unknown topic: ${missing.join(', ')}`, ErrorCode.VALIDATION_ERROR);
    }
    return bySlug;
  }

  /** Contacts whose effective subscription to the topic is on. */
  public static subscribedWhere(topic: Pick<Topic, 'id' | 'basis'>): Prisma.ContactWhereInput {
    return topic.basis === TopicBasis.OPT_IN
      ? {topicStates: {some: {topicId: topic.id, subscribed: true}}}
      : {topicStates: {none: {topicId: topic.id, subscribed: false}}};
  }

  /** Whether the project sends campaigns per topic. */
  public static async enabled(projectId: string): Promise<boolean> {
    const project = await prisma.project.findUnique({where: {id: projectId}, select: {topicsEnabled: true}});
    return project?.topicsEnabled === true;
  }

  /**
   * What a campaign's audience is narrowed to in a project with topics: the contacts subscribed to its
   * topic. A campaign without a topic, with a topic campaigns cannot be sent for, or of the
   * TRANSACTIONAL type reaches nobody there, so that no path can send around a topic. `null` in a
   * project without topics, which keeps upstream's audience.
   */
  public static async campaignAudienceWhere(
    projectId: string,
    campaign: Pick<Campaign, 'topicId' | 'type'>,
  ): Promise<Prisma.ContactWhereInput | null> {
    if (!(await this.enabled(projectId))) {
      return null;
    }
    if (campaign.type === TemplateType.TRANSACTIONAL || !campaign.topicId) {
      return NOBODY;
    }
    const topic = await prisma.topic.findFirst({where: {id: campaign.topicId, projectId}});
    if (!topic || !topic.campaignSelectable) {
      return NOBODY;
    }
    return this.subscribedWhere(topic);
  }

  /**
   * Check a campaign's type and topic against the project's topics, before it is created or changed
   * (`requireTopic: false`, a draft may not have a topic yet) or sent (`requireTopic: true`).
   */
  public static async assertCampaign(
    projectId: string,
    campaign: {type?: TemplateType | null; topicId?: string | null},
    {requireTopic}: {requireTopic: boolean},
  ): Promise<void> {
    const enabled = await this.enabled(projectId);

    if (!enabled) {
      if (campaign.topicId) {
        throw new HttpException(400, 'Topics are not enabled for this project', ErrorCode.VALIDATION_ERROR);
      }
      return;
    }

    if (campaign.type === TemplateType.TRANSACTIONAL) {
      throw new HttpException(
        400,
        'A project with topics cannot send transactional campaigns: send that mail through the API instead',
        ErrorCode.VALIDATION_ERROR,
      );
    }

    if (!campaign.topicId) {
      if (requireTopic) {
        throw new HttpException(400, 'Choose the topic this campaign is sent for', ErrorCode.VALIDATION_ERROR);
      }
      return;
    }

    const topic = await prisma.topic.findFirst({where: {id: campaign.topicId, projectId}});
    if (!topic) {
      throw new NotFound('topic', campaign.topicId);
    }
    if (!topic.campaignSelectable) {
      throw new HttpException(
        400,
        `Campaigns cannot be sent for the topic "${topic.name}"`,
        ErrorCode.VALIDATION_ERROR,
      );
    }
  }

  /** Every topic of the project with the contact's state, in topic order. */
  public static async contactStates(projectId: string, contactId: string): Promise<ContactTopicState[]> {
    const [topics, states] = await Promise.all([
      this.list(projectId),
      prisma.contactTopic.findMany({where: {contactId, topic: {projectId}}}),
    ]);
    const explicit = new Map(states.map(state => [state.topicId, state.subscribed]));

    return topics.map(topic => {
      const state = explicit.get(topic.id) ?? null;
      return {
        id: topic.id,
        slug: topic.slug,
        name: topic.name,
        description: topic.description,
        basis: topic.basis,
        subscribed: state ?? topic.basis === TopicBasis.OPT_OUT,
        explicit: state,
      };
    });
  }

  /**
   * Set a contact's explicit state for some topics, by slug (`true` subscribes, `false` unsubscribes,
   * `null` removes the explicit state, so the basis decides again). Runs in `tx` when given.
   */
  public static async setContactStates(
    projectId: string,
    contactId: string,
    states: Record<string, boolean | null>,
    tx: Prisma.TransactionClient = prisma,
    topics?: Map<string, Topic>,
  ): Promise<void> {
    const bySlug = topics ?? (await this.bySlugs(projectId, Object.keys(states)));

    for (const [slug, subscribed] of Object.entries(states)) {
      const topic = bySlug.get(slug)!;
      if (subscribed === null) {
        await tx.contactTopic.deleteMany({where: {contactId, topicId: topic.id}});
      } else {
        await tx.contactTopic.upsert({
          where: {contactId_topicId: {contactId, topicId: topic.id}},
          create: {contactId, topicId: topic.id, subscribed},
          update: {subscribed},
        });
      }
    }
  }
}
