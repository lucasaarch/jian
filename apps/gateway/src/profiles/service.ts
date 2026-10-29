import { randomUUID } from 'node:crypto';
import { type Profile, profilePatchSchema, profileSchema } from '@jian/contracts';
import { and, eq, isNull } from 'drizzle-orm';
import { type Clock, nowIso } from '../core/clock.js';
import { assertFound, GatewayError } from '../core/errors.js';
import { recordEvent } from '../core/events.js';
import { environmentProvider, type ProviderKind, providerCatalog } from '../providers/catalog.js';
import type { Queryable, Store } from '../storage/database.js';
import { providers } from '../storage/schema.js';
import {
  deleteProfileRow,
  findProfile,
  insertProfile,
  insertRevision,
  listProfiles,
  listRevisions,
  updateProfileRow,
} from './repository.js';
import { forget, hasActiveRun } from './reset.js';

export class Profiles {
  constructor(
    private readonly store: Store,
    private readonly clock: Clock = Date.now,
  ) {}

  /**
   * Run ahead of every delete, inside the same transaction the row dies in. Wired once, from
   * outside — `Profiles` does not know `Channels` exists, only that something may need telling
   * before a profile it is watching disappears (a live WhatsApp socket, an open webhook).
   */
  private beforeDelete?: (profileId: string, tx: Queryable) => Promise<void>;

  useBeforeDelete(hook: (profileId: string, tx: Queryable) => Promise<void>): void {
    this.beforeDelete = hook;
  }

  async profile(id: string, reader: Queryable = this.store.db) {
    return assertFound(await findProfile(reader, id), 'Profile');
  }

  async profiles() {
    return listProfiles(this.store.db);
  }

  async createProfile(input: unknown) {
    const data = profileSchema.parse(input);

    const profile: Profile = {
      ...data,
      id: randomUUID(),
      version: 1,
      createdAt: nowIso(this.clock),
      updatedAt: nowIso(this.clock),
    };

    return this.store.transaction(profile.id, async (tx) => {
      await this.validateReferences(profile, tx);
      await insertProfile(tx, profile);
      await insertRevision(tx, profile);

      await recordEvent(tx, this.clock, profile.id, 'profile.created', {
        profileId: profile.id,
        version: 1,
      });

      return profile;
    });
  }

  /** A profile may only name its own live provider, and one skill per name. */
  private async validateReferences(profile: Profile, reader: Queryable) {
    const names = profile.skills.map((skill) => skill.name);

    if (new Set(names).size !== names.length) {
      throw new GatewayError(400, 'Skill names must be unique within a profile');
    }

    const providerId = profile.model.providerId;

    if (!providerId) {
      return;
    }

    const fromEnvironment = (Object.keys(providerCatalog) as ProviderKind[]).some(
      (kind) => environmentProvider(kind)?.id === providerId,
    );

    if (fromEnvironment) {
      return;
    }

    const [live] = await reader
      .select({ id: providers.id })
      .from(providers)
      .where(and(eq(providers.id, providerId), isNull(providers.revokedAt)))
      .limit(1);

    if (!live) {
      throw new GatewayError(400, 'Provider reference is not configured on this gateway');
    }
  }

  async updateProfile(id: string, input: unknown) {
    const { expectedVersion, ...patch } = profilePatchSchema.parse(input);

    return this.store.transaction(id, async (tx) => {
      const current = await this.profile(id, tx);

      if (current.version !== expectedVersion) {
        throw new GatewayError(409, 'Profile version changed; reload before editing');
      }

      const patched: Profile = {
        ...current,
        ...patch,
        version: current.version + 1,
        updatedAt: nowIso(this.clock),
      };

      await this.validateReferences(patched, tx);
      const profile = patched;

      await updateProfileRow(tx, profile);
      await insertRevision(tx, profile);

      await recordEvent(tx, this.clock, id, 'profile.updated', {
        profileId: id,
        version: profile.version,
      });

      return profile;
    });
  }

  async revisions(id: string) {
    await this.profile(id);

    return listRevisions(this.store.db, id);
  }

  /**
   * The one row every session, memory, channel, contact, run and secret of this profile
   * references with `ON DELETE CASCADE` — removing it takes all of that with it, in the
   * database. `beforeDelete` gets a chance first, inside the same transaction, for whatever
   * lives outside a row: a linked device's open socket, a webhook a vendor still calls.
   */
  async deleteProfile(id: string): Promise<{ id: string }> {
    await this.profile(id);

    await this.store.transaction(id, async (tx) => {
      await this.beforeDelete?.(id, tx);
      await deleteProfileRow(tx, id);
    });

    return { id };
  }

  /**
   * The profile forgets everything it lived: sessions, memories and its activity. What the
   * owner gave it stays — name, instructions, skills, permissions, channels, contacts and
   * secrets. Refused while an answer is running, which would otherwise
   * write into a conversation that no longer exists.
   */
  async resetProfile(id: string): Promise<{ id: string; sessions: number; memories: number }> {
    await this.profile(id);

    return this.store.transaction(id, async (tx) => {
      if (await hasActiveRun(tx, id)) {
        throw new GatewayError(
          409,
          'An answer is still running. Wait for it to finish, or cancel it, then reset.',
        );
      }

      const forgotten = await forget(tx, id);

      // The feed starts over with this, so an open panel reloads what is left.
      await recordEvent(tx, this.clock, id, 'profile.reset', forgotten);

      return { id, ...forgotten };
    });
  }
}
