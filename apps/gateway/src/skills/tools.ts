import { MAX_LIBRARY_SKILLS, type Run, skillNameSchema } from '@jian/contracts';
import { type ToolSet, tool } from 'ai';
import { z } from 'zod';
import type { SkillLibrary } from './library.js';

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
 * The skills an agent writes: added to the library every agent is offered, then rewritten and
 * removed one at a time, and only by the agent that wrote them. One the owner wrote or
 * imported, or another agent wrote, is read like any other and never changed from here; the
 * library refuses it and says whose it is. The built-in names belong to the gateway.
 */
export function skillTools(library: SkillLibrary, run: Run): ToolSet {
  const yours = async () =>
    (await library.list())
      .filter((skill) => skill.authorProfileId === run.profileId)
      .map(({ name, description }) => ({ name, description }));

  return {
    create_skill: tool({
      description: `Write a skill: how to handle one kind of situation, the same way every time. It joins the library shared with every agent of this installation, which holds ${MAX_LIBRARY_SKILLS}, and is offered from the next turn on.`,
      inputSchema: z.object({
        name: skillNameSchema.describe('Lowercase, digits, - and _: the job, like weekly-report.'),
        ...fields,
      }),
      execute: async (input) => {
        await library.create(input, run.profileId);

        return { created: input.name, yours: await yours() };
      },
    }),

    update_skill: tool({
      description:
        'Rewrite one of the skills you wrote: its description, its instructions, or both. Every agent follows the new text. Skills the owner wrote or imported, or another agent wrote, cannot be changed.',
      inputSchema: z.object({
        name: skillNameSchema,
        description: fields.description.optional(),
        instructions: fields.instructions.optional(),
      }),
      execute: async ({ name, ...patch }) => {
        await library.update(name, patch, run.profileId);

        return { updated: name, yours: await yours() };
      },
    }),

    delete_skill: tool({
      description:
        'Remove one of the skills you wrote from the shared library, when it is wrong, unused or merged into another. No agent is offered it afterwards.',
      inputSchema: z.object({ name: skillNameSchema }),
      execute: async ({ name }) => {
        await library.remove(name, run.profileId);

        return { deleted: name, yours: await yours() };
      },
    }),
  };
}
