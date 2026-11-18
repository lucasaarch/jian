import {
  type BuiltinSkill,
  type LibrarySkill,
  MAX_LIBRARY_SKILLS,
  type McpServer,
  type Skill,
  skillCreateSchema,
  skillEnabledSchema,
  skillPatchSchema,
  skillSchema,
} from '@jian/contracts';
import { eq, sql } from 'drizzle-orm';
import type { Clock } from '../core/clock.js';
import { GatewayError } from '../core/errors.js';
import { GATEWAY_SCOPE } from '../security/gateway-vault.js';
import type { Queryable, Store } from '../storage/database.js';
import { skills } from '../storage/schema.js';
import { builtinSkillNames, builtinSkills, type SkillLibraryState } from './builtin/index.js';
import { readSkillLibrary, writeDisabledSkills } from './repository.js';

/** One more than the row holds: every change to what a skill says is a version of it. */
const nextVersion = sql`${skills.version} + 1`;

/**
 * The installation's skills: one library every agent is offered, beside the built-in ones. The
 * owner writes, imports, edits and removes any of them; an agent, given as `agent`, changes
 * only what it wrote itself, so who is behind an instruction stays answerable. Every change
 * runs under the installation's lock, so two writers cannot pass the cap or take one name.
 */
export class SkillLibrary {
  constructor(
    private readonly store: Store,
    private readonly clock: Clock = Date.now,
  ) {}

  /** What a run is offered from: the skills, and the names switched off. */
  read(reader: Queryable = this.store.db): Promise<SkillLibraryState> {
    return readSkillLibrary(reader);
  }

  async list(): Promise<LibrarySkill[]> {
    return [...(await this.read()).skills];
  }

  /**
   * The built-in skills with their instructions, which the owner cannot edit and so must be
   * able to read. `servers` decide the ones that teach MCP tools, as they do for a run.
   */
  async builtin(servers: readonly McpServer[]): Promise<BuiltinSkill[]> {
    const disabled = new Set((await this.read()).disabled);

    return builtinSkills(servers, { worktrees: true }).map((skill) => ({
      ...skill,
      enabled: !disabled.has(skill.name),
    }));
  }

  private async held(reader: Queryable, name: string, agent?: string): Promise<LibrarySkill> {
    const skill = (await this.read(reader)).skills.find((item) => item.name === name);

    if (!skill) throw new GatewayError(404, `There is no skill named ${name}`);

    if (agent && !(skill.writtenBy === 'agent' && skill.authorProfileId === agent)) {
      throw new GatewayError(
        403,
        skill.writtenBy === 'agent'
          ? `${name} was written by another agent; ask the owner to change it`
          : `${name} was ${skill.origin ? 'imported' : 'written'} by the owner; ask them to change it`,
      );
    }

    return skill;
  }

  /** Written by the owner, or by the agent given as `agent`. */
  async create(input: unknown, agent?: string): Promise<LibrarySkill> {
    const skill = skillCreateSchema.parse(input);

    if (builtinSkillNames.has(skill.name)) {
      throw new GatewayError(409, `${skill.name} is a built-in skill of this gateway`);
    }

    return this.store.transaction(GATEWAY_SCOPE, async (tx) => {
      const library = (await this.read(tx)).skills;

      if (library.some((item) => item.name === skill.name)) {
        throw new GatewayError(409, `A skill named ${skill.name} exists; update it instead`);
      }

      if (library.length >= MAX_LIBRARY_SKILLS) {
        throw new GatewayError(
          409,
          `The skill library holds ${MAX_LIBRARY_SKILLS} skills already; merge or remove one first`,
        );
      }

      const at = new Date(this.clock());

      await tx.insert(skills).values({
        ...skill,
        ...(agent ? { writtenBy: 'agent' as const, authorProfileId: agent } : {}),
        createdAt: at,
        updatedAt: at,
      });

      return this.held(tx, skill.name);
    });
  }

  async update(name: string, input: unknown, agent?: string): Promise<LibrarySkill> {
    const patch = skillPatchSchema.parse(input);

    return this.store.transaction(GATEWAY_SCOPE, async (tx) => {
      await this.held(tx, name, agent);
      await tx
        .update(skills)
        .set({ ...patch, version: nextVersion, updatedAt: new Date(this.clock()) })
        .where(eq(skills.name, name));

      return this.held(tx, name);
    });
  }

  /** Its name leaves the switched-off list too, or a later skill of that name would start off. */
  async remove(name: string, agent?: string): Promise<void> {
    await this.store.transaction(GATEWAY_SCOPE, async (tx) => {
      await this.held(tx, name, agent);
      await tx.delete(skills).where(eq(skills.name, name));

      const { disabled } = await this.read(tx);

      if (disabled.includes(name)) {
        await writeDisabledSkills(
          tx,
          disabled.filter((item) => item !== name),
          new Date(this.clock()),
        );
      }
    });
  }

  /** One switch for a built-in skill and a library one, for every agent at once. */
  async setEnabled(name: string, input: unknown): Promise<{ name: string; enabled: boolean }> {
    const { enabled } = skillEnabledSchema.parse(input);

    return this.store.transaction(GATEWAY_SCOPE, async (tx) => {
      const library = await this.read(tx);

      if (!builtinSkillNames.has(name) && !library.skills.some((item) => item.name === name)) {
        throw new GatewayError(404, `There is no skill named ${name}`);
      }

      await writeDisabledSkills(
        tx,
        enabled ? library.disabled.filter((item) => item !== name) : [...library.disabled, name],
        new Date(this.clock()),
      );

      return { name, enabled };
    });
  }

  /**
   * Adds what the owner imported. One that shares a name with a library skill replaces it,
   * whoever wrote that one: an import is the owner's, and so is the skill from then on. It was
   * last changed when it was imported, to the millisecond, so a later `updatedAt` means someone
   * edited it here.
   */
  async addImported(input: Skill[]): Promise<LibrarySkill[]> {
    // A document from a repository: its name and sizes are checked here, as a typed one's are.
    const imported = input.map((skill) => skillSchema.parse(skill));

    return this.store.transaction(GATEWAY_SCOPE, async (tx) => {
      const held = new Set((await this.read(tx)).skills.map((skill) => skill.name));
      const names = new Set(imported.map((skill) => skill.name));

      if (new Set([...held, ...names]).size > MAX_LIBRARY_SKILLS) {
        throw new GatewayError(409, `The skill library holds at most ${MAX_LIBRARY_SKILLS} skills`);
      }

      const at = new Date(this.clock());

      for (const { name, description, instructions, origin } of imported) {
        const written = {
          description,
          instructions,
          origin: origin ?? null,
          writtenBy: null,
          updatedAt: origin ? new Date(origin.importedAt) : at,
        };

        await tx
          .insert(skills)
          .values({ name, ...written, authorProfileId: null, createdAt: at })
          .onConflictDoUpdate({
            target: skills.name,
            set: { ...written, authorProfileId: null, version: nextVersion },
          });
      }

      return (await this.read(tx)).skills.filter((skill) => names.has(skill.name));
    });
  }

  /**
   * Replaces what an imported skill says with its source's document, read by the caller before
   * the lock is taken. The skill keeps its name, whatever the document calls itself now, and
   * its place in the library. Refused for a skill that was not imported.
   */
  async refreshImported(
    name: string,
    document: Pick<Skill, 'description' | 'instructions'> & { license?: string },
  ): Promise<LibrarySkill> {
    return this.store.transaction(GATEWAY_SCOPE, async (tx) => {
      const { origin } = await this.held(tx, name);

      if (!origin) throw new GatewayError(409, `${name} was not imported; it has no source`);

      const at = new Date(this.clock());
      const { license: _before, ...from } = origin;

      await tx
        .update(skills)
        .set({
          description: document.description,
          instructions: document.instructions,
          origin: {
            ...from,
            ...(document.license ? { license: document.license } : {}),
            importedAt: at.toISOString(),
          },
          version: nextVersion,
          updatedAt: at,
        })
        .where(eq(skills.name, name));

      return this.held(tx, name);
    });
  }
}
