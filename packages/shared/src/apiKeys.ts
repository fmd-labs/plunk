/**
 * Scoped API keys (fork D37). A project's own secret key has full access; a scoped key may call only the routes its
 * scopes list, and the API refuses everything else.
 */

/** The scopes a scoped key can hold. */
export const API_KEY_SCOPES = ['draft', 'sync'] as const;

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/** What each scope allows, as the dashboard and the docs say it. */
export const API_KEY_SCOPE_DESCRIPTIONS: Record<ApiKeyScope, string> = {
  draft:
    'Drafts marketing campaigns, templates, segments and layouts, and sends tests to the team. It never sends or schedules a campaign, never lists contacts, and never changes anything that sends without a person.',
  sync: 'Keeps contacts in step: batch upserts, lookups and deletes, topics and subscriptions, layouts, and unsubscribe reports.',
};

/** Scoped keys start with this, so the API tells them from a project's own key (`sk_` and hex) without a lookup. */
export const SCOPED_API_KEY_PREFIX = 'sk_scoped_';
