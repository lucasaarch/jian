import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import { realpath } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  FILE_LINK_DEFAULT_MINUTES,
  FILE_LINK_MAX_BYTES,
  FILE_LINK_MAX_MINUTES,
} from '@jian/contracts';
import { and, count, eq, gt, isNull, lte, or } from 'drizzle-orm';
import { workspaceHome } from '../agent/workspace-home.js';
import type { Clock } from '../core/clock.js';
import { hashSecret } from '../devices/tokens.js';
import type { Store } from '../storage/database.js';
import { fileLinks, projects, sessions } from '../storage/schema.js';
import {
  assertOwnPlace,
  LinkRefused,
  type OwnsPlace,
  openReal,
  realOf,
  sharedParts,
} from './place.js';
import { plainName } from './serve.js';

/** 32 random bytes in base64url: the whole proof a reader holds. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
/** A link in the agent's words: the id it was given, or the address itself. */
const LINK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * Live links one agent may hold at once. A link costs a row and nothing else, but an agent in a
 * loop could otherwise keep making them; past this it revokes some or waits for them to expire.
 */
export const MAX_LIVE_LINKS = 500;

export type MadeLink = {
  linkId: string;
  url: string;
  name: string;
  bytes: number;
  expiresAt: string;
};

/** A link being read: its file open, as it was when the link was made. The caller closes it. */
export type OpenLink = {
  handle: FileHandle;
  name: string;
  bytes: number;
  modifiedMs: number;
  expiresAt: Date;
  /** When the link was found live, by the service's clock: what a cache's lifetime counts from. */
  checkedAt: number;
};

/**
 * Temporary links to one file each in the directory the agents share, for a server gateway that
 * the internet reaches at an https:// address. `place.ts` says which files may be linked. A link
 * reads the file at request time, and answers only while it is the same file that was shared,
 * the same size and modification time: a file changed or deleted since answers 404, so a link
 * never starts serving something else written at its path. Sharing it again makes a new link.
 */
export class FileLinks {
  constructor(
    private readonly store: Store,
    /** `JIAN_PUBLIC_URL`, an https:// address: the gateway is built without links otherwise. */
    private readonly publicUrl: string,
    private readonly clock: Clock = Date.now,
    private readonly home: () => Promise<string> = workspaceHome,
  ) {}

  private readonly owns: OwnsPlace = async (profileId, kind, id) => {
    const table = kind === 'project' ? projects : sessions;
    const [row] = await this.store.db
      .select({ id: table.id })
      .from(table)
      .where(and(eq(table.id, id), eq(table.profileId, profileId)))
      .limit(1);
    return Boolean(row);
  };

  /** A link to the file at `path` for `minutes`, made by the agent of `owner`. */
  async create(
    owner: { profileId: string; sessionId: string },
    input: { path: string; minutes?: number | undefined },
  ): Promise<MadeLink> {
    const minutes = input.minutes ?? FILE_LINK_DEFAULT_MINUTES;
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > FILE_LINK_MAX_MINUTES) {
      throw new LinkRefused(`A link lasts from 1 to ${FILE_LINK_MAX_MINUTES} minutes (7 days).`);
    }
    const home = await this.home();
    const real = await realOf(input.path);
    const parts = sharedParts(home, real, input.path);
    await assertOwnPlace(owner.profileId, parts, this.owns, input.path);

    const { handle, info } = await openReal(real);
    await handle.close();
    if (info.isDirectory()) {
      throw new LinkRefused(
        `${input.path} is a folder. A link is to one file: zip the folder first to share it whole.`,
      );
    }
    if (!info.isFile()) throw new LinkRefused(`${input.path} is not a regular file`);
    if (info.size === 0) throw new LinkRefused(`${input.path} is empty`);
    if (info.size > FILE_LINK_MAX_BYTES) {
      throw new LinkRefused(
        `${input.path} has ${info.size} bytes; a link takes files up to 2 GB. Make it smaller or split it.`,
      );
    }

    const now = new Date(this.clock());
    const live = and(
      eq(fileLinks.profileId, owner.profileId),
      isNull(fileLinks.revokedAt),
      gt(fileLinks.expiresAt, now),
    );
    // What can never answer again is only clutter: gone as the agent makes its next.
    await this.store.db
      .delete(fileLinks)
      .where(
        and(
          eq(fileLinks.profileId, owner.profileId),
          or(lte(fileLinks.expiresAt, now), lte(fileLinks.revokedAt, now)),
        ),
      );
    const [held] = await this.store.db.select({ live: count() }).from(fileLinks).where(live);
    if ((held?.live ?? 0) >= MAX_LIVE_LINKS) {
      throw new LinkRefused(
        `This agent already has ${held?.live} live links. Revoke some with revoke_file_link, or wait for them to expire.`,
      );
    }

    const token = randomBytes(32).toString('base64url');
    const id = randomUUID();
    const expiresAt = new Date(now.getTime() + minutes * 60_000);
    await this.store.db.insert(fileLinks).values({
      id,
      profileId: owner.profileId,
      sessionId: owner.sessionId,
      tokenHash: hashSecret(token),
      path: parts.join('/'),
      bytes: info.size,
      modifiedMs: Math.trunc(info.mtimeMs),
      createdAt: now,
      expiresAt,
    });
    const name = basename(real);

    return {
      linkId: id,
      url: new URL(
        `/v1/file-links/${token}/${encodeURIComponent(plainName(name))}`,
        this.publicUrl,
      ).toString(),
      name,
      bytes: info.size,
      expiresAt: expiresAt.toISOString(),
    };
  }

  /**
   * Ends one of this agent's links at once, named by its id or by its address. Another agent's
   * link is as unknown here as one that never existed.
   */
  async revoke(profileId: string, link: string): Promise<{ linkId: string; revoked: true }> {
    const token = /\/v1\/file-links\/([^/?#]+)/.exec(link)?.[1] ?? link.trim();
    const which = LINK_ID.test(link.trim())
      ? eq(fileLinks.id, link.trim())
      : TOKEN.test(token)
        ? eq(fileLinks.tokenHash, hashSecret(token))
        : undefined;
    if (!which) throw new LinkRefused('Name the link by the linkId or the url it was made with.');

    const now = new Date(this.clock());
    const [row] = await this.store.db
      .update(fileLinks)
      .set({ revokedAt: now })
      .where(and(which, eq(fileLinks.profileId, profileId), isNull(fileLinks.revokedAt)))
      .returning({ id: fileLinks.id });
    if (!row) {
      throw new LinkRefused(
        'No live link of yours matches; it may have expired, been revoked already, or never been made here.',
      );
    }
    return { linkId: row.id, revoked: true };
  }

  /**
   * The file behind a token, opened, or undefined for anything that must not answer: a token
   * never made, revoked, expired, a file changed, moved or deleted since, or a place no longer
   * within the rules. The caller answers every one of those the same way.
   */
  async open(token: string): Promise<OpenLink | undefined> {
    if (!TOKEN.test(token)) return undefined;
    const hash = hashSecret(token);
    const [row] = await this.store.db
      .select()
      .from(fileLinks)
      .where(eq(fileLinks.tokenHash, hash))
      .limit(1);
    // The index found it by hash; this comparison is the one a reader could time, so it takes
    // as long whichever byte differs.
    if (!row || !timingSafeEqual(Buffer.from(row.tokenHash, 'hex'), Buffer.from(hash, 'hex'))) {
      return undefined;
    }
    const checkedAt = this.clock();
    if (row.revokedAt || row.expiresAt.getTime() <= checkedAt) return undefined;

    try {
      const home = await this.home();
      const stored = join(home, ...row.path.split('/'));
      // Stored as a real path: a symlink anywhere on the way now resolves elsewhere and is refused.
      if ((await realpath(stored)) !== stored) return undefined;
      const parts = sharedParts(home, stored, stored);
      await assertOwnPlace(row.profileId, parts, this.owns, stored);
      const { handle, info } = await openReal(stored);
      if (
        !info.isFile() ||
        info.size !== row.bytes ||
        Math.trunc(info.mtimeMs) !== row.modifiedMs
      ) {
        await handle.close();
        return undefined;
      }
      return {
        handle,
        name: basename(stored),
        bytes: row.bytes,
        modifiedMs: row.modifiedMs,
        expiresAt: row.expiresAt,
        checkedAt,
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        error instanceof LinkRefused ||
        code === 'ENOENT' ||
        code === 'ENOTDIR' ||
        code === 'ELOOP' ||
        code === 'EACCES'
      ) {
        return undefined;
      }
      throw error;
    }
  }
}
