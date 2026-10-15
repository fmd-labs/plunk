import useSWR from 'swr';

/** A scoped API key as `GET /api-keys` returns it, without its secret (fork D37). */
export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

/** The active project's scoped API keys, revoked ones included (fork D37); none fetched while `enabled` is false. */
export function useApiKeys(enabled = true) {
  return useSWR<ApiKey[]>(enabled ? '/api-keys' : null, {revalidateOnFocus: false});
}
