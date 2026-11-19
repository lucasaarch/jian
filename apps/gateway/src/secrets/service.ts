import {
  type Secret,
  type SecretField,
  secretCreateSchema,
  secretUpdateSchema,
} from '@jian/contracts';
import { and, asc, eq, inArray, ne, notExists, notInArray, sql } from 'drizzle-orm';
import type { Clock } from '../core/clock.js';
import { GatewayError } from '../core/errors.js';
import { GATEWAY_SCOPE, type GatewayVault } from '../security/gateway-vault.js';
import type { Queryable, Store } from '../storage/database.js';
import { profiles, secretAgents, secretEntries, secretFields } from '../storage/schema.js';

/** Who asks for a change: the owner from the panel, or an agent through its tools. */
export type SecretActor = { kind: 'owner' } | { kind: 'agent'; profileId: string };

/**
 * Where a field made through this service keeps its value in the gateway vault, which binds the
 * value to this key. A field carried from a command secret keeps `command:<name>` instead, so the
 * key is read from the field's row, never rebuilt from this.
 */
export const secretFieldKey = (secretId: string, envName: string) =>
  `secret:${secretId}:${envName}`;

/** What an agent is told of a Secret it may use: never a sensitive value. */
export type OfferedSecret = {
  id: string;
  title: string;
  description: string | null;
  sites: string[];
  fields: SecretField[];
};

/**
 * A variable a command gets, and whether it is masked in what the command prints: read with the
 * value, so a field made sensitive while a run goes on is masked from its next command.
 */
export type LentValue = { value: string; sensitive: boolean };

/** The masking floor (`forms.ts`): shorter, a sensitive value would mask ordinary output. */
const SHORTEST_SENSITIVE = 8;

const notHere = () => new GatewayError(404, 'This agent has no such Secret.');
const notYours = () =>
  new GatewayError(
    403,
    'This Secret was made by the owner or another agent: you can use it, not change it.',
  );
const clash = (envName: string) =>
  new GatewayError(409, `A Secret already uses the variable ${envName}. Choose another name.`);

/** A list of origins, each once: two pages of one site are one place to use a Secret. */
const sitesOf = (sites: readonly string[]) => [...new Set(sites)];

/**
 * The installation's Secrets for agents' commands. A sensitive value goes in and never comes back
 * out through a route: the only readers are `reveal`, which hands a command of an agent that may
 * use them every value of the Secrets it names, and `masks`, which every run uses to take them
 * out of what it records. A value that is not sensitive, such as a username, is shown.
 *
 * Every call acts through one agent (the settings page it was opened from, or the agent itself),
 * and a Secret that agent may not use is not there for it: it cannot be read, changed, shared or
 * deleted from there. An agent may change or delete only a Secret it made.
 */
export class Secrets {
  constructor(
    private readonly store: Store,
    private readonly vault: GatewayVault,
    private readonly clock: Clock = Date.now,
  ) {}

  /** The Secrets this agent's commands may use, each with every agent that may. */
  async list(profileId: string, reader: Queryable = this.store.db): Promise<Secret[]> {
    const mine = reader
      .select({ id: secretAgents.secretId })
      .from(secretAgents)
      .where(eq(secretAgents.profileId, profileId));
    const rows = await reader
      .select()
      .from(secretEntries)
      .where(inArray(secretEntries.id, mine))
      .orderBy(asc(secretEntries.title), asc(secretEntries.createdAt), asc(secretEntries.id));
    if (!rows.length) return [];

    const ids = rows.map((row) => row.id);
    const fields = await reader
      .select()
      .from(secretFields)
      .where(inArray(secretFields.secretId, ids))
      .orderBy(asc(secretFields.position));
    const grants = await reader
      .select()
      .from(secretAgents)
      .where(inArray(secretAgents.secretId, ids))
      .orderBy(asc(secretAgents.profileId));
    // A plain value that cannot be decrypted (a lost key) shows as empty rather than taking the
    // whole list down with it: the owner can still see the Secret and type the value again.
    const shown = await Promise.all(
      fields.map(async (field) =>
        field.sensitive
          ? null
          : ((await this.vault.read(field.vaultKey, reader).catch(() => undefined)) ?? null),
      ),
    );

    return rows.map((row) => {
      const granted = grants.filter((grant) => grant.secretId === row.id);
      return {
        id: row.id,
        title: row.title,
        description: row.description,
        sites: row.sites,
        fields: fields.flatMap((field, index) =>
          field.secretId === row.id
            ? [
                {
                  label: field.label,
                  envName: field.envName,
                  sensitive: field.sensitive,
                  value: shown[index] ?? null,
                },
              ]
            : [],
        ),
        profileIds: granted.map((grant) => grant.profileId),
        grants: granted.map((grant) => ({
          profileId: grant.profileId,
          grantedByProfileId: grant.grantedByProfileId,
          grantedAt: grant.grantedAt.toISOString(),
        })),
        createdByProfileId: row.createdByProfileId,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
        lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
      };
    });
  }

  /**
   * Made from one agent, which may always use it. The owner may name others; an agent's Secret is
   * its own until it shares it, so the agents it names are ignored.
   */
  async create(profileId: string, input: unknown, by: SecretActor): Promise<Secret> {
    const asked = secretCreateSchema.parse(input);
    const agents = [
      ...new Set([profileId, ...(by.kind === 'owner' ? (asked.profileIds ?? []) : [])]),
    ];

    return this.store.transaction(GATEWAY_SCOPE, async (tx) => {
      await this.assertAgents(tx, agents, profileId);
      await this.assertFree(
        tx,
        asked.fields.map((field) => field.envName),
      );
      const now = new Date(this.clock());
      const [made] = await tx
        .insert(secretEntries)
        .values({
          title: asked.title,
          description: asked.description || null,
          sites: sitesOf(asked.sites ?? []),
          createdByProfileId: by.kind === 'agent' ? by.profileId : null,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: secretEntries.id });
      if (!made) throw new Error('The Secret was not saved');

      await tx.insert(secretFields).values(
        asked.fields.map((field, position) => ({
          secretId: made.id,
          position,
          label: field.label,
          envName: field.envName,
          sensitive: field.sensitive,
          vaultKey: secretFieldKey(made.id, field.envName),
        })),
      );
      for (const field of asked.fields) {
        // The schema refused a field with no value on a create.
        await this.vault.put(secretFieldKey(made.id, field.envName), field.value as string, tx);
      }
      await tx.insert(secretAgents).values(
        agents.map((agent) => ({
          secretId: made.id,
          profileId: agent,
          grantedByProfileId: by.kind === 'agent' ? by.profileId : null,
          grantedAt: now,
        })),
      );

      return this.one(tx, profileId, made.id);
    });
  }

  /**
   * The fields given replace the list. One left out is gone, value and all; one given without a
   * value keeps the value it has, under the key it has.
   */
  async update(
    profileId: string,
    secretId: string,
    input: unknown,
    by: SecretActor,
  ): Promise<Secret> {
    const asked = secretUpdateSchema.parse(input);

    return this.store.transaction(GATEWAY_SCOPE, async (tx) => {
      const current = await this.one(tx, profileId, secretId);
      this.assertMaker(current, by);
      if (asked.profileIds && by.kind === 'agent') {
        throw new GatewayError(403, 'Only the owner chooses which agents use a Secret.');
      }
      if (asked.profileIds) await this.assertAgents(tx, asked.profileIds);
      const now = new Date(this.clock());

      if (asked.fields) await this.replaceFields(tx, secretId, asked.fields);
      await tx
        .update(secretEntries)
        .set({
          ...(asked.title !== undefined ? { title: asked.title } : {}),
          ...(asked.description !== undefined ? { description: asked.description || null } : {}),
          ...(asked.sites !== undefined ? { sites: sitesOf(asked.sites) } : {}),
          updatedAt: now,
        })
        .where(eq(secretEntries.id, secretId));
      if (asked.profileIds) await this.replaceGrants(tx, secretId, asked.profileIds, now);

      // Read as an agent that still has it: the one it was changed from may have handed it on.
      const [after] = await this.listOf(tx, secretId);
      if (!after) throw notHere();
      return after;
    });
  }

  /** Gone for every agent that could use it, every value with it. */
  async remove(profileId: string, secretId: string, by: SecretActor): Promise<{ id: string }> {
    return this.store.transaction(GATEWAY_SCOPE, async (tx) => {
      this.assertMaker(await this.one(tx, profileId, secretId), by);
      await this.drop(tx, [secretId]);
      return { id: secretId };
    });
  }

  /** Lets another agent use a Secret this one may use, recording that this one did. */
  async share(
    profileId: string,
    secretId: string,
    toProfileId: string,
  ): Promise<{ shared: boolean }> {
    return this.store.transaction(GATEWAY_SCOPE, async (tx) => {
      await this.one(tx, profileId, secretId);
      const [target] = await tx
        .select({ id: profiles.id })
        .from(profiles)
        .where(eq(profiles.id, toProfileId));
      if (!target) throw new GatewayError(404, 'There is no agent with that id.');

      const now = new Date(this.clock());
      const granted = await tx
        .insert(secretAgents)
        .values({ secretId, profileId: toProfileId, grantedByProfileId: profileId, grantedAt: now })
        .onConflictDoNothing()
        .returning({ secretId: secretAgents.secretId });
      if (!granted.length) return { shared: false };

      await tx.update(secretEntries).set({ updatedAt: now }).where(eq(secretEntries.id, secretId));
      return { shared: true };
    });
  }

  /**
   * Run as an agent is deleted, in its transaction: a Secret only it could use would otherwise
   * stay in the vault with no page that shows it. One others use stays; the foreign keys set its
   * maker, and any grant this agent made, back to null.
   */
  async forgetAgent(profileId: string, tx: Queryable): Promise<void> {
    const others = tx
      .select({ one: sql`1` })
      .from(secretAgents)
      .where(
        and(eq(secretAgents.secretId, secretEntries.id), ne(secretAgents.profileId, profileId)),
      );
    const mine = tx
      .select({ id: secretAgents.secretId })
      .from(secretAgents)
      .where(eq(secretAgents.profileId, profileId));
    const orphans = await tx
      .select({ id: secretEntries.id })
      .from(secretEntries)
      .where(and(inArray(secretEntries.id, mine), notExists(others)));

    await this.drop(
      tx,
      orphans.map((orphan) => orphan.id),
    );
  }

  /** What an agent's run is told of the Secrets it may use. */
  async usable(profileId: string): Promise<OfferedSecret[]> {
    return (await this.list(profileId)).map(({ id, title, description, sites, fields }) => ({
      id,
      title,
      description,
      sites,
      fields,
    }));
  }

  /**
   * The values for one command of this agent, read at the moment it runs. Each variable named
   * brings its whole Secret: a username is no use without its password. A Secret deleted or taken
   * from the agent since the run started is refused, as is any variable it may not use, before
   * anything runs.
   */
  async reveal(profileId: string, envNames: readonly string[]): Promise<Record<string, LentValue>> {
    const wanted = [...new Set(envNames)];
    if (!wanted.length) return {};
    const allowed = await this.store.db
      .select({ envName: secretFields.envName, secretId: secretFields.secretId })
      .from(secretFields)
      .innerJoin(
        secretAgents,
        and(
          eq(secretAgents.secretId, secretFields.secretId),
          eq(secretAgents.profileId, profileId),
        ),
      )
      .where(inArray(secretFields.envName, wanted));
    const found = new Set(allowed.map((row) => row.envName));
    const refused = wanted.filter((name) => !found.has(name));
    if (refused.length) {
      throw new GatewayError(
        403,
        `Not run: this agent may not use ${refused.join(', ')}. Name a variable listed in run_command's description. The owner adds Secrets in this agent's settings, under Secrets.`,
      );
    }

    const ids = [...new Set(allowed.map((row) => row.secretId))];
    const fields = await this.store.db
      .select({
        envName: secretFields.envName,
        vaultKey: secretFields.vaultKey,
        sensitive: secretFields.sensitive,
      })
      .from(secretFields)
      .where(inArray(secretFields.secretId, ids));
    const values: Record<string, LentValue> = {};
    for (const field of fields) {
      const value = await this.vault.read(field.vaultKey);
      if (value === undefined) throw notHere();
      values[field.envName] = { value, sensitive: field.sensitive };
    }
    await this.store.db
      .update(secretEntries)
      .set({ lastUsedAt: new Date(this.clock()) })
      .where(inArray(secretEntries.id, ids));

    return values;
  }

  /**
   * Every sensitive value the installation keeps, for masking. Every agent's runs mask all of
   * them, not only their own: files are shared, so a value one agent's command wrote to disk is
   * there for another's to read. A value that cannot be decrypted is skipped: it could not be used
   * either. A value that is not sensitive is not masked: it may be as short as a word.
   */
  async masks(): Promise<string[]> {
    const rows = await this.store.db
      .select({ vaultKey: secretFields.vaultKey })
      .from(secretFields)
      .where(eq(secretFields.sensitive, true));
    const values = await Promise.all(
      rows.map(({ vaultKey }) => this.vault.read(vaultKey).catch(() => undefined)),
    );

    return values.filter((value): value is string => Boolean(value));
  }

  private async replaceFields(
    tx: Queryable,
    secretId: string,
    asked: { label: string; envName: string; sensitive: boolean; value?: string | undefined }[],
  ): Promise<void> {
    const before = await tx.select().from(secretFields).where(eq(secretFields.secretId, secretId));
    const kept = new Map(before.map((field) => [field.envName, field]));
    await this.assertFree(
      tx,
      asked.map((field) => field.envName).filter((name) => !kept.has(name)),
    );

    const after: (typeof secretFields.$inferInsert)[] = [];
    for (const [position, field] of asked.entries()) {
      const old = kept.get(field.envName);
      const vaultKey = old?.vaultKey ?? secretFieldKey(secretId, field.envName);
      if (field.value !== undefined) {
        await this.vault.put(vaultKey, field.value, tx);
      } else if (!old) {
        throw new GatewayError(400, `Give a value for ${field.envName}: it is a new field.`);
      } else if (field.sensitive && !old.sensitive) {
        // Only when it turns sensitive: a value already sensitive passed this check when it was
        // saved, so renaming its label never decrypts it.
        const value = await this.vault.read(old.vaultKey, tx);
        if ((value ?? '').length < SHORTEST_SENSITIVE) {
          throw new GatewayError(
            400,
            'A sensitive value has at least 8 characters: type a longer one',
          );
        }
      } else if (old.sensitive && !field.sensitive) {
        // A plain value is returned on every read: a sensitive one never is, so it is typed again.
        throw new GatewayError(
          400,
          `${field.envName} was sensitive, so its value is never shown: type the value again to make it not sensitive.`,
        );
      }
      after.push({
        secretId,
        position,
        label: field.label,
        envName: field.envName,
        sensitive: field.sensitive,
        vaultKey,
      });
    }

    await tx.delete(secretFields).where(eq(secretFields.secretId, secretId));
    await tx.insert(secretFields).values(after);
    const names = new Set(asked.map((field) => field.envName));
    for (const field of before) {
      if (!names.has(field.envName)) await this.vault.discard(field.vaultKey, tx);
    }
  }

  /** Who may use it now: a grant that stays keeps who made it and when. */
  private async replaceGrants(
    tx: Queryable,
    secretId: string,
    profileIds: readonly string[],
    now: Date,
  ): Promise<void> {
    const agents = [...new Set(profileIds)];
    await tx
      .delete(secretAgents)
      .where(and(eq(secretAgents.secretId, secretId), notInArray(secretAgents.profileId, agents)));
    await tx
      .insert(secretAgents)
      .values(agents.map((agent) => ({ secretId, profileId: agent, grantedAt: now })))
      .onConflictDoNothing();
  }

  /** Deletes these Secrets, and every value of theirs in the vault. */
  private async drop(tx: Queryable, ids: readonly string[]): Promise<void> {
    if (!ids.length) return;
    const fields = await tx
      .select({ vaultKey: secretFields.vaultKey })
      .from(secretFields)
      .where(inArray(secretFields.secretId, [...ids]));
    await tx.delete(secretEntries).where(inArray(secretEntries.id, [...ids]));
    for (const { vaultKey } of fields) await this.vault.discard(vaultKey, tx);
  }

  private async one(tx: Queryable, profileId: string, secretId: string): Promise<Secret> {
    const found = (await this.list(profileId, tx)).find((secret) => secret.id === secretId);
    if (!found) throw notHere();
    return found;
  }

  /** The Secret as any agent that has it sees it. */
  private async listOf(tx: Queryable, secretId: string): Promise<Secret[]> {
    const [grant] = await tx
      .select({ profileId: secretAgents.profileId })
      .from(secretAgents)
      .where(eq(secretAgents.secretId, secretId))
      .limit(1);
    if (!grant) return [];
    return (await this.list(grant.profileId, tx)).filter((secret) => secret.id === secretId);
  }

  /** The owner may change any Secret; an agent only one it made. */
  private assertMaker(secret: Secret, by: SecretActor): void {
    if (by.kind === 'agent' && secret.createdByProfileId !== by.profileId) throw notYours();
  }

  /** No other Secret already hands a command these variables. */
  private async assertFree(tx: Queryable, envNames: readonly string[]): Promise<void> {
    if (!envNames.length) return;
    const [taken] = await tx
      .select({ envName: secretFields.envName })
      .from(secretFields)
      .where(inArray(secretFields.envName, [...envNames]))
      .limit(1);
    if (taken) throw clash(taken.envName);
  }

  /** Every agent named exists; `required`, the one the request came through, among them. */
  private async assertAgents(tx: Queryable, ids: readonly string[], required?: string) {
    const unique = [...new Set(ids)];
    const found = await tx
      .select({ id: profiles.id })
      .from(profiles)
      .where(inArray(profiles.id, unique));
    if (required && !found.some((row) => row.id === required)) {
      throw new GatewayError(404, 'Profile not found');
    }
    if (found.length !== unique.length) {
      throw new GatewayError(400, 'One of the agents chosen to use this Secret does not exist.');
    }
  }
}
