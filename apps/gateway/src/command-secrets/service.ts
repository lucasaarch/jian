import {
  type CommandSecret,
  commandSecretCreateSchema,
  commandSecretUpdateSchema,
} from '@jian/contracts';
import { and, asc, eq, inArray, notExists, sql } from 'drizzle-orm';
import type { Clock } from '../core/clock.js';
import { GatewayError } from '../core/errors.js';
import { GATEWAY_SCOPE, type GatewayVault } from '../security/gateway-vault.js';
import type { Queryable, Store } from '../storage/database.js';
import { commandSecretAgents, commandSecrets, profiles } from '../storage/schema.js';

/** Where a command secret's value lives in the gateway vault, which binds it to this name. */
export const commandSecretKey = (name: string) => `command:${name}`;

/** What an agent is told of a secret it may use: never its value. */
export type OfferedSecret = { name: string; description: string | null };

const NOT_HERE = (name: string) =>
  new GatewayError(404, `This agent has no command secret named ${name}.`);

/**
 * The owner's secrets for agents' commands. A value goes in once and never comes back out through
 * a route: the only reader is `reveal`, which hands named values to one command of an agent that
 * may use them, and `masks`, which every run uses to take them out of what it records.
 *
 * Every route acts through one agent (the settings page it was opened from), and a secret that
 * agent may not use is not there for it: it cannot be read, changed or deleted from there.
 */
export class CommandSecrets {
  constructor(
    private readonly store: Store,
    private readonly vault: GatewayVault,
    private readonly clock: Clock = Date.now,
  ) {}

  /** The secrets this agent's commands may use, each with every agent that may. */
  async list(profileId: string, reader: Queryable = this.store.db): Promise<CommandSecret[]> {
    const mine = reader
      .select({ name: commandSecretAgents.name })
      .from(commandSecretAgents)
      .where(eq(commandSecretAgents.profileId, profileId));
    const rows = await reader
      .select()
      .from(commandSecrets)
      .where(inArray(commandSecrets.name, mine))
      .orderBy(asc(commandSecrets.name));
    if (!rows.length) return [];

    const grants = await reader
      .select()
      .from(commandSecretAgents)
      .where(
        inArray(
          commandSecretAgents.name,
          rows.map((row) => row.name),
        ),
      );

    return rows.map((row) => ({
      name: row.name,
      description: row.description,
      profileIds: grants
        .filter((grant) => grant.name === row.name)
        .map((grant) => grant.profileId)
        .sort(),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    }));
  }

  async create(profileId: string, input: unknown): Promise<CommandSecret> {
    const asked = commandSecretCreateSchema.parse(input);
    const agents = [...new Set([profileId, ...(asked.profileIds ?? [])])];

    return this.store.transaction(GATEWAY_SCOPE, async (tx) => {
      await this.assertAgents(tx, agents, profileId);
      const now = new Date(this.clock());
      const [made] = await tx
        .insert(commandSecrets)
        .values({
          name: asked.name,
          description: asked.description || null,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .returning({ name: commandSecrets.name });
      if (!made) {
        throw new GatewayError(
          409,
          `A command secret named ${asked.name} already exists. Choose another name, or let this agent use it from an agent that has it.`,
        );
      }
      await tx
        .insert(commandSecretAgents)
        .values(agents.map((agent) => ({ name: asked.name, profileId: agent })));
      await this.vault.put(commandSecretKey(asked.name), asked.value, tx);

      return this.one(tx, profileId, asked.name);
    });
  }

  async update(profileId: string, name: string, input: unknown): Promise<CommandSecret> {
    const asked = commandSecretUpdateSchema.parse(input);

    return this.store.transaction(GATEWAY_SCOPE, async (tx) => {
      await this.one(tx, profileId, name);
      if (asked.profileIds) await this.assertAgents(tx, asked.profileIds);

      await tx
        .update(commandSecrets)
        .set({
          ...(asked.description !== undefined ? { description: asked.description || null } : {}),
          updatedAt: new Date(this.clock()),
        })
        .where(eq(commandSecrets.name, name));
      if (asked.value !== undefined) await this.vault.put(commandSecretKey(name), asked.value, tx);
      if (asked.profileIds) {
        await tx.delete(commandSecretAgents).where(eq(commandSecretAgents.name, name));
        await tx
          .insert(commandSecretAgents)
          .values([...new Set(asked.profileIds)].map((agent) => ({ name, profileId: agent })));
      }

      // Read as the agent it was changed from, which may have just handed it to others alone.
      const [after] = await this.listOf(tx, name);
      if (!after) throw NOT_HERE(name);
      return after;
    });
  }

  /** Gone for every agent that could use it, value and all. */
  async remove(profileId: string, name: string): Promise<{ name: string }> {
    return this.store.transaction(GATEWAY_SCOPE, async (tx) => {
      await this.one(tx, profileId, name);
      await tx.delete(commandSecrets).where(eq(commandSecrets.name, name));
      await this.vault.discard(commandSecretKey(name), tx);
      return { name };
    });
  }

  /**
   * Run as an agent is deleted, in its transaction: a secret only it could use would otherwise
   * stay in the vault with no page that shows it.
   */
  async forgetAgent(profileId: string, tx: Queryable): Promise<void> {
    const others = tx
      .select({ one: sql`1` })
      .from(commandSecretAgents)
      .where(
        and(
          eq(commandSecretAgents.name, commandSecrets.name),
          sql`${commandSecretAgents.profileId} <> ${profileId}`,
        ),
      );
    const mine = tx
      .select({ name: commandSecretAgents.name })
      .from(commandSecretAgents)
      .where(eq(commandSecretAgents.profileId, profileId));
    const orphans = await tx
      .delete(commandSecrets)
      .where(and(inArray(commandSecrets.name, mine), notExists(others)))
      .returning({ name: commandSecrets.name });

    for (const { name } of orphans) await this.vault.discard(commandSecretKey(name), tx);
  }

  /** The names and descriptions an agent's run is told about. */
  async usable(profileId: string): Promise<OfferedSecret[]> {
    return (await this.list(profileId)).map(({ name, description }) => ({ name, description }));
  }

  /**
   * The values of these secrets, for one command of this agent, read at the moment it runs: a
   * secret deleted or taken from the agent since the run started is refused, as is any name it
   * may not use, before anything runs.
   */
  async reveal(profileId: string, names: readonly string[]): Promise<Record<string, string>> {
    const wanted = [...new Set(names)];
    if (!wanted.length) return {};
    const allowed = new Set(
      (
        await this.store.db
          .select({ name: commandSecretAgents.name })
          .from(commandSecretAgents)
          .where(
            and(
              eq(commandSecretAgents.profileId, profileId),
              inArray(commandSecretAgents.name, wanted),
            ),
          )
      ).map((row) => row.name),
    );
    const refused = wanted.filter((name) => !allowed.has(name));
    if (refused.length) {
      throw new GatewayError(
        403,
        `Not run: this agent may not use ${refused.join(', ')}. Only the command secrets listed in run_command's description can be used; the owner adds them in this agent's settings.`,
      );
    }

    const values: Record<string, string> = {};
    for (const name of wanted) {
      const value = await this.vault.read(commandSecretKey(name));
      if (value === undefined) throw NOT_HERE(name);
      values[name] = value;
    }
    await this.store.db
      .update(commandSecrets)
      .set({ lastUsedAt: new Date(this.clock()) })
      .where(inArray(commandSecrets.name, wanted));

    return values;
  }

  /**
   * Every value the installation keeps, for masking. Every agent's runs mask all of them, not
   * only their own: files are shared, so a value one agent's command wrote to disk is there for
   * another's to read. A value that cannot be decrypted is skipped: it could not be used either.
   */
  async masks(): Promise<string[]> {
    const rows = await this.store.db.select({ name: commandSecrets.name }).from(commandSecrets);
    const values = await Promise.all(
      rows.map(({ name }) => this.vault.read(commandSecretKey(name)).catch(() => undefined)),
    );

    return values.filter((value): value is string => Boolean(value));
  }

  private async one(tx: Queryable, profileId: string, name: string): Promise<CommandSecret> {
    const found = (await this.list(profileId, tx)).find((secret) => secret.name === name);
    if (!found) throw NOT_HERE(name);
    return found;
  }

  /** The secret as any agent sees it. */
  private async listOf(tx: Queryable, name: string): Promise<CommandSecret[]> {
    const [grant] = await tx
      .select({ profileId: commandSecretAgents.profileId })
      .from(commandSecretAgents)
      .where(eq(commandSecretAgents.name, name))
      .limit(1);
    if (!grant) return [];
    return (await this.list(grant.profileId, tx)).filter((secret) => secret.name === name);
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
      throw new GatewayError(400, 'One of the agents chosen to use this secret does not exist.');
    }
  }
}
