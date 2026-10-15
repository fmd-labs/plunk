/**
 * Fork (D37): the scoped API key behind a change to a campaign, template or segment. A key's id, `null` for a person
 * or the project's own key, or `undefined` when the caller doesn't say (an internal change, which leaves it as is).
 */
export type ChangedBy = string | null | undefined;

/** A new row's attribution: the key that created it is also the one that changed it last. */
export const createdBy = (by: ChangedBy) => ({createdByKeyId: by ?? null, updatedByKeyId: by ?? null});

/** A change's attribution, when the caller says whose it is. */
export const updatedBy = (by: ChangedBy) => (by === undefined ? {} : {updatedByKeyId: by});
