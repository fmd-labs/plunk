import type {ApiKey, Project} from '@plunk/db';
import {type ApiKeyScope, SCOPED_API_KEY_PREFIX} from '@plunk/shared';
import {createHash, randomBytes} from 'node:crypto';
import signale from 'signale';

import {prisma} from '../database/prisma.js';
import {HttpException} from '../exceptions/index.js';

/** A key as the API shows it: never its secret's hash. */
export type ApiKeySummary = Omit<ApiKey, 'secretHash'>;

/** `lastUsedAt` is written at most this often, rather than on every request a key makes. */
const LAST_USED_RESOLUTION_MS = 60_000;

/** How much of the secret is kept to tell keys apart, after the prefix. */
const VISIBLE_SECRET_CHARS = 6;

const hashSecret = (secret: string) => createHash('sha256').update(secret).digest('hex');

/**
 * Scoped API keys (fork D37): created and revoked by a project's admins, shown in full once, stored as a hash.
 * A revoked key stays, so the attribution that names it still resolves.
 */
export class ApiKeyService {
  /** Whether a secret is a scoped key's, rather than a project's own. */
  public static isScoped(secret: string): boolean {
    return secret.startsWith(SCOPED_API_KEY_PREFIX);
  }

  public static async list(projectId: string): Promise<ApiKeySummary[]> {
    return prisma.apiKey.findMany({where: {projectId}, omit: {secretHash: true}, orderBy: {createdAt: 'desc'}});
  }

  /** A new key, and its secret: the only time the secret is seen. */
  public static async create(
    projectId: string,
    input: {name: string; scopes: ApiKeyScope[]},
  ): Promise<{key: ApiKeySummary; secret: string}> {
    const secret = `${SCOPED_API_KEY_PREFIX}${randomBytes(24).toString('hex')}`;
    const key = await prisma.apiKey.create({
      data: {
        projectId,
        name: input.name,
        scopes: input.scopes,
        prefix: secret.slice(0, SCOPED_API_KEY_PREFIX.length + VISIBLE_SECRET_CHARS),
        secretHash: hashSecret(secret),
      },
      omit: {secretHash: true},
    });
    return {key, secret};
  }

  /** Revokes a key at once: its next request is refused. */
  public static async revoke(projectId: string, keyId: string): Promise<ApiKeySummary> {
    const key = await prisma.apiKey.findFirst({where: {id: keyId, projectId}, omit: {secretHash: true}});
    if (!key) {
      throw new HttpException(404, 'API key not found');
    }
    if (key.revokedAt) {
      return key;
    }
    return prisma.apiKey.update({where: {id: keyId}, data: {revokedAt: new Date()}, omit: {secretHash: true}});
  }

  /** The key a scoped secret is and its project, or null for one that is unknown or revoked. */
  public static async authenticate(secret: string): Promise<{key: ApiKeySummary; project: Project} | null> {
    const found = await prisma.apiKey.findUnique({
      where: {secretHash: hashSecret(secret)},
      include: {project: true},
      omit: {secretHash: true},
    });
    if (!found || found.revokedAt) {
      return null;
    }
    const {project, ...key} = found;
    this.touch(key);
    return {key, project};
  }

  /** Records that a key was used, at most once a minute and never in the request's way. */
  private static touch(key: ApiKeySummary): void {
    const since = new Date(Date.now() - LAST_USED_RESOLUTION_MS);
    if (key.lastUsedAt && key.lastUsedAt > since) {
      return;
    }
    prisma.apiKey
      .updateMany({
        where: {id: key.id, OR: [{lastUsedAt: null}, {lastUsedAt: {lt: since}}]},
        data: {lastUsedAt: new Date()},
      })
      .catch((error: unknown) => signale.warn(`[API-KEYS] Couldn't record the use of key ${key.id}:`, error));
  }
}
