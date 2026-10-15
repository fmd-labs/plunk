import {type Campaign, CampaignStatus, Prisma, type Topic, TemplateType, TopicBasis} from '@plunk/db';
import type {FilterCondition} from '@plunk/types';

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

  /**
   * Create the topic with this slug, or update it. An update changes only the fields given, so that
   * leaving `basis` out never turns an OPT_IN topic into an OPT_OUT one, which would subscribe every
   * contact without an explicit state.
   */
  public static async upsert(
    projectId: string,
    slug: string,
    input: TopicInput,
  ): Promise<{topic: Topic; created: boolean}> {
    const existing = await prisma.topic.findUnique({where: {projectId_slug: {projectId, slug}}, select: {id: true}});
    const topic = await prisma.topic.upsert({
      where: {projectId_slug: {projectId, slug}},
      create: {
        projectId,
        slug,
        name: input.name,
        description: input.description ?? null,
        basis: input.basis ?? TopicBasis.OPT_OUT,
        campaignSelectable: input.campaignSelectable ?? true,
        listId: input.listId ?? null,
      },
      update: {
        name: input.name,
        description: input.description,
        basis: input.basis,
        campaignSelectable: input.campaignSelectable,
        listId: input.listId,
      },
    });
    return {topic, created: !existing};
  }

  /**
   * Delete a topic and every contact's state for it. Campaigns sent for it keep their stats and lose
   * the link, and drafts need another topic before they are sent. Refused (409) while a campaign is
   * scheduled or sending for the topic, or a segment or such a campaign filters on it: the campaign
   * would reach nobody, and the filter would fail on every evaluation.
   */
  public static async delete(projectId: string, slug: string): Promise<void> {
    const topic = await this.get(projectId, slug);
    const field = `"topic.${topic.id}"`;

    const [campaigns, segments] = await Promise.all([
      prisma.campaign.findMany({
        where: {projectId, status: {in: [CampaignStatus.SCHEDULED, CampaignStatus.SENDING]}},
        select: {name: true, topicId: true, audienceCondition: true},
      }),
      prisma.segment.findMany({where: {projectId}, select: {name: true, condition: true}}),
    ]);
    const users = [
      ...campaigns
        .filter(c => c.topicId === topic.id || JSON.stringify(c.audienceCondition ?? null).includes(field))
        .map(c => `campaign "${c.name}"`),
      ...segments.filter(s => JSON.stringify(s.condition ?? null).includes(field)).map(s => `segment "${s.name}"`),
    ];

    if (users.length > 0) {
      throw new HttpException(
        409,
        `The topic "${topic.name}" is in use by ${users.join(', ')}. Change or cancel those first.`,
        ErrorCode.CONFLICT,
      );
    }

    await prisma.topic.delete({where: {id: topic.id}});
  }

  /**
   * Refuse a filter on a topic the project does not have (`topic.<id>`), anywhere in a condition. The
   * filter is otherwise built from the topic id alone, and another project's topic would pass.
   */
  public static async assertTopicFilters(projectId: string, condition: FilterCondition | null | undefined): Promise<void> {
    const ids = new Set<string>();
    const collect = (c: FilterCondition) => {
      for (const group of c.groups) {
        for (const filter of group.filters) {
          if (filter.field.startsWith('topic.')) {
            ids.add(filter.field.substring(6));
          }
        }
        if (group.conditions) {
          collect(group.conditions);
        }
      }
    };
    if (condition) {
      collect(condition);
    }
    if (ids.size === 0) {
      return;
    }

    const found = await prisma.topic.findMany({where: {projectId, id: {in: [...ids]}}, select: {id: true}});
    const missing = [...ids].filter(id => !found.some(topic => topic.id === id));
    if (missing.length > 0) {
      throw new HttpException(400, `Referenced topic not found: ${missing.join(', ')}`, ErrorCode.VALIDATION_ERROR);
    }
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

  /**
   * Contacts whose effective subscription to the topic is on. `after`, the id a page of contacts ordered
   * by id starts after, bounds the topic states looked at too: it changes nothing about which contacts
   * match, but lets the database read the states of that page's contacts from the
   * `(topicId, subscribed, contactId)` index rather than every state of the topic, page after page.
   */
  public static subscribedWhere(topic: Pick<Topic, 'id' | 'basis'>, after?: string): Prisma.ContactWhereInput {
    const bound = after ? {contactId: {gt: after}} : {};
    return topic.basis === TopicBasis.OPT_IN
      ? {topicStates: {some: {topicId: topic.id, subscribed: true, ...bound}}}
      : {topicStates: {none: {topicId: topic.id, subscribed: false, ...bound}}};
  }

  /** Whether the project sends campaigns per topic. */
  public static async enabled(projectId: string): Promise<boolean> {
    const project = await prisma.project.findUnique({where: {id: projectId}, select: {topicsEnabled: true}});
    return project?.topicsEnabled === true;
  }

  /**
   * What a campaign's audience is narrowed to: the contacts subscribed to its topic. That holds for a
   * campaign with a topic even after the project turned topics off, so that turning them off never
   * widens a campaign already scheduled or sending. In a project with topics, a campaign without a
   * topic, with a topic campaigns cannot be sent for, or of the TRANSACTIONAL type reaches nobody, so
   * that no path can send around a topic. `null` for a campaign without a topic in a project without
   * topics, which keeps upstream's audience. `after` bounds a page, see {@link subscribedWhere}.
   */
  public static async campaignAudienceWhere(
    projectId: string,
    campaign: Pick<Campaign, 'topicId' | 'type'>,
    after?: string,
  ): Promise<Prisma.ContactWhereInput | null> {
    if (!campaign.topicId) {
      return (await this.enabled(projectId)) ? NOBODY : null;
    }
    if (campaign.type === TemplateType.TRANSACTIONAL) {
      return NOBODY;
    }
    const topic = await prisma.topic.findFirst({where: {id: campaign.topicId, projectId}});
    if (!topic || !topic.campaignSelectable) {
      return NOBODY;
    }
    return this.subscribedWhere(topic, after);
  }

  /**
   * Check a campaign's type and topic against the project's topics, before it is created or changed
   * (`requireTopic: false`, a draft may not have a topic yet; a scheduled campaign must keep one) or
   * sent (`requireTopic: true`). `storedTopicId` is the topic the campaign has now: a project that
   * turned topics off keeps it (the campaign stays narrowed to it, see {@link campaignAudienceWhere})
   * but takes no new one.
   */
  public static async assertCampaign(
    projectId: string,
    campaign: {type?: TemplateType | null; topicId?: string | null},
    {requireTopic, storedTopicId}: {requireTopic: boolean; storedTopicId?: string | null},
  ): Promise<void> {
    const enabled = await this.enabled(projectId);

    if (!enabled) {
      if (campaign.topicId && campaign.topicId !== storedTopicId) {
        throw new HttpException(400, 'Topics are not enabled for this project', ErrorCode.VALIDATION_ERROR);
      }
      if (campaign.topicId && campaign.type === TemplateType.TRANSACTIONAL) {
        throw new HttpException(
          400,
          'A campaign with a topic cannot be transactional: clear its topic first',
          ErrorCode.VALIDATION_ERROR,
        );
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
    tx?: Prisma.TransactionClient,
    topics?: Map<string, Topic>,
  ): Promise<void> {
    const bySlug = topics ?? (await this.bySlugs(projectId, Object.keys(states)));
    // All of the states or none.
    if (!tx) {
      return prisma.$transaction(client => this.setContactStates(projectId, contactId, states, client, bySlug));
    }

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
