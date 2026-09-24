import {
  MEMORY_LINK_LIMIT,
  type Memory,
  memoryEditSchema,
  memoryKeySchema,
  memorySchema,
} from '@jian/contracts';
import { type Clock, nowIso } from '../core/clock.js';
import { assertFound, GatewayError } from '../core/errors.js';
import { recordEvent } from '../core/events.js';
import type { ProfileReader } from '../profiles/port.js';
import type { SessionReader } from '../sessions/port.js';
import type { Store } from '../storage/database.js';
import {
  addLink,
  deleteMemory,
  findMemory,
  linksOf,
  listMemories,
  memoryId,
  removeLink,
  searchMemories,
  withLinks,
  writeMemory,
} from './repository.js';

export class Memories {
  constructor(
    private readonly store: Store,
    private readonly profiles: ProfileReader,
    private readonly sessions: SessionReader,
    private readonly clock: Clock = Date.now,
  ) {}

  async memories(profileId: string) {
    await this.profiles.profile(profileId);

    return withLinks(this.store.db, profileId, await listMemories(this.store.db, profileId));
  }

  /** Whatever mentions any of the words, newest first, with what each one is linked to. */
  async search(profileId: string, query: string, limit = 30) {
    await this.profiles.profile(profileId);
    const words = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])].slice(0, 12);
    const found = words.length
      ? await searchMemories(this.store.db, profileId, words, limit)
      : await listMemories(this.store.db, profileId, limit);

    return withLinks(this.store.db, profileId, found);
  }

  /**
   * The owner rewriting a memory from the panel. It is a new version like any other, against
   * the version the owner read, and it no longer points at the conversation that first wrote it.
   */
  async edit(profileId: string, key: unknown, input: unknown) {
    const memoryKey = memoryKeySchema.parse(key);
    const { content, expectedVersion } = memoryEditSchema.parse(input);

    await this.profiles.profile(profileId);
    assertFound(await findMemory(this.store.db, profileId, memoryKey), 'Memory');

    return this.remember(profileId, { key: memoryKey, content, expectedVersion });
  }

  /**
   * Two memories recalled together from now on: when one is relevant to a request, the other
   * comes with it. Both must exist, and a memory holds a bounded number of links.
   */
  async link(profileId: string, key: unknown, linkedKey: unknown) {
    const a = memoryKeySchema.parse(key);
    const b = memoryKeySchema.parse(linkedKey);

    if (a === b) throw new GatewayError(400, 'A memory cannot be linked to itself');

    return this.store.transaction(profileId, async (tx) => {
      await this.profiles.profile(profileId, tx);
      const memory = assertFound(await findMemory(tx, profileId, a), 'Memory');
      assertFound(await findMemory(tx, profileId, b), 'Memory');
      const links = await linksOf(tx, profileId, [a, b]);

      if (!links.get(a)?.includes(b)) {
        for (const side of [a, b]) {
          if ((links.get(side)?.length ?? 0) >= MEMORY_LINK_LIMIT) {
            throw new GatewayError(
              409,
              `${side} already has ${MEMORY_LINK_LIMIT} links; unlink one first`,
            );
          }
        }

        await addLink(tx, profileId, a, b);
        await recordEvent(tx, this.clock, profileId, 'memory.linked', { keys: [a, b] });
      }

      return (await withLinks(tx, profileId, [memory]))[0] as Memory;
    });
  }

  async unlink(profileId: string, key: unknown, linkedKey: unknown) {
    const a = memoryKeySchema.parse(key);
    const b = memoryKeySchema.parse(linkedKey);

    return this.store.transaction(profileId, async (tx) => {
      await this.profiles.profile(profileId, tx);
      const memory = assertFound(await findMemory(tx, profileId, a), 'Memory');

      await removeLink(tx, profileId, a, b);
      await recordEvent(tx, this.clock, profileId, 'memory.unlinked', { keys: [a, b] });

      return (await withLinks(tx, profileId, [memory]))[0] as Memory;
    });
  }

  async remember(profileId: string, input: unknown, sourceSessionId?: string) {
    const { expectedVersion, ...data } = memorySchema.parse(input);

    return this.store.transaction(profileId, async (tx) => {
      await this.profiles.profile(profileId, tx);

      if (sourceSessionId) {
        await this.sessions.session(profileId, sourceSessionId, tx);
      }

      const old = await findMemory(tx, profileId, data.key);

      if ((old?.version ?? 0) !== expectedVersion) {
        throw new GatewayError(409, 'Memory version changed; reload before editing');
      }

      const memory: Memory = {
        ...data,
        id: memoryId(profileId, data.key),
        profileId,
        version: expectedVersion + 1,
        sourceSessionId,
        updatedAt: nowIso(this.clock),
      };

      // The row can only have moved on under a writer outside this profile's lock; the guard
      // is the table's, so the answer is the conflict either way.
      if (!(await writeMemory(tx, memory, expectedVersion))) {
        throw new GatewayError(409, 'Memory version changed; reload before editing');
      }

      await recordEvent(tx, this.clock, profileId, 'memory.updated', {
        key: memory.key,
        version: memory.version,
        sourceSessionId,
      });

      return memory;
    });
  }

  /**
   * Takes a memory off the shelf, with its links. The owner does it to a wrong one, which an
   * agent would otherwise repeat in every new session; the agent does it to one it outgrew.
   */
  async forget(profileId: string, key: unknown) {
    const memoryKey = memoryKeySchema.parse(key);

    return this.store.transaction(profileId, async (tx) => {
      await this.profiles.profile(profileId, tx);

      const memory = assertFound(await findMemory(tx, profileId, memoryKey), 'Memory');

      await deleteMemory(tx, profileId, memoryKey);

      await recordEvent(tx, this.clock, profileId, 'memory.forgotten', {
        key: memory.key,
        version: memory.version,
      });

      return memory;
    });
  }
}
