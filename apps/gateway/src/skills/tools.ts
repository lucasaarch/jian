import { type Profile, type Run, type Skill, skillNameSchema } from '@jian/contracts';
import { type ToolSet, tool } from 'ai';
import { z } from 'zod';
import { GatewayError } from '../core/errors.js';
import { builtinSkillNames } from './builtin/index.js';

/** The same bound the profile holds, said where the agent reads it. */
const MAX_SKILLS = 20;

type ProfileSkills = {
  profile(id: string): Promise<Profile>;
  updateProfile(id: string, input: unknown): Promise<Profile>;
};

const fields = {
  description: z
    .string()
    .min(1)
    .max(300)
    .describe('When to use it, in the words the situation arrives in: "Use when …".'),
  instructions: z
    .string()
    .min(1)
    .max(12_000)
    .describe('The steps, their order, the decisions, and what to do when one fails.'),
};

/**
 * The agent's own skills: written, rewritten and removed one at a time, and only its own. A
 * skill the owner wrote or imported is read like any other and never changed from here; the
 * built-in names belong to the gateway. Each change is made against the version just read,
 * and read again once if the owner saved meanwhile.
 */
export function skillTools(profiles: ProfileSkills, run: Run): ToolSet {
  const change = async (edit: (skills: Skill[]) => Skill[]) => {
    for (let attempt = 0; ; attempt++) {
      const current = await profiles.profile(run.profileId);

      try {
        const updated = await profiles.updateProfile(run.profileId, {
          expectedVersion: current.version,
          skills: edit(current.skills),
        });

        return updated.skills
          .filter((skill) => skill.writtenBy === 'agent')
          .map(({ name, description }) => ({ name, description }));
      } catch (error) {
        if (attempt > 0 || !(error instanceof GatewayError) || error.statusCode !== 409)
          throw error;
      }
    }
  };

  const yours = (skills: Skill[], name: string) => {
    const skill = skills.find((item) => item.name === name);

    if (!skill) throw new GatewayError(404, `There is no skill named ${name}`);
    if (skill.writtenBy !== 'agent')
      throw new GatewayError(403, `${name} was written by the owner; ask them to change it`);

    return skill;
  };

  return {
    create_skill: tool({
      description:
        'Write a skill for yourself: how to handle one kind of situation, the same way every time. It is offered to you from your next turn on.',
      inputSchema: z.object({
        name: skillNameSchema.describe('Lowercase, digits, - and _: the job, like weekly-report.'),
        ...fields,
      }),
      execute: async (input) => ({
        created: input.name,
        yours: await change((skills) => {
          if (builtinSkillNames.has(input.name))
            throw new GatewayError(409, `${input.name} is a built-in skill of this gateway`);
          if (skills.some((skill) => skill.name === input.name))
            throw new GatewayError(409, `A skill named ${input.name} exists; update it instead`);
          if (skills.length >= MAX_SKILLS)
            throw new GatewayError(
              409,
              `This profile holds ${MAX_SKILLS} skills already; merge or remove one of yours first`,
            );

          return [...skills, { ...input, writtenBy: 'agent' }];
        }),
      }),
    }),

    update_skill: tool({
      description:
        'Rewrite one of the skills you wrote: its description, its instructions, or both. Skills the owner wrote or imported cannot be changed.',
      inputSchema: z.object({
        name: skillNameSchema,
        description: fields.description.optional(),
        instructions: fields.instructions.optional(),
      }),
      execute: async ({ name, ...patch }) => ({
        updated: name,
        yours: await change((skills) => {
          yours(skills, name);

          return skills.map((skill) => (skill.name === name ? { ...skill, ...patch } : skill));
        }),
      }),
    }),

    delete_skill: tool({
      description:
        'Remove one of the skills you wrote, when it is wrong, unused or merged into another.',
      inputSchema: z.object({ name: skillNameSchema }),
      execute: async ({ name }) => ({
        deleted: name,
        yours: await change((skills) => {
          yours(skills, name);

          return skills.filter((skill) => skill.name !== name);
        }),
      }),
    }),
  };
}
