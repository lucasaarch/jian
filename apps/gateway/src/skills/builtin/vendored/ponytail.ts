import type { Skill } from '@jian/contracts';

/** Adapted from Ponytail 4.10.0 for Jian's file, shell and skill tools. See THIRD_PARTY_NOTICES.md. */
const origin = {
  url: 'https://github.com/DietrichGebert/ponytail/tree/e3ba2aa6f1e6f0bc4d69eb09c9f0d0a93af56156/skills',
  ref: 'e3ba2aa6f1e6f0bc4d69eb09c9f0d0a93af56156',
  importedAt: '2026-09-29T00:00:00.000Z',
};

const ponytail: Skill = {
  name: 'ponytail',
  description:
    'Automatically active for coding work. Choose the simplest complete solution without cutting safety.',
  origin,
  instructions: `# Ponytail — coding work

Be a lazy senior developer: efficient, not careless. First understand the request and trace the real path through the code. Then stop at the first solution that works:

1. If the need is speculative, skip it and say why.
2. Reuse a fitting helper, type or pattern already in this codebase.
3. Prefer the standard library, native platform and installed dependencies.
4. Only then write the smallest coherent new implementation.

Fix root causes in the responsible shared layer, not symptoms in one caller. Preserve existing behavior and user changes. Do not add speculative interfaces, factories, configuration, dependencies or scaffolding. Deletion and consolidation beat duplication. Do not contort the design merely to minimize changed lines.

Never cut trust-boundary validation, authorization, security, data-loss prevention, error handling, accessibility or required tests. For a nontrivial change, leave a runnable regression check. Match the project's conventions. Run the smallest sufficient proof and report only what actually passed.

Default mode is full. The owner can send /ponytail lite, /ponytail full, /ponytail ultra or /ponytail off as a separate message. That choice persists in this conversation until another command changes it. Lite builds what was asked and briefly names a simpler alternative; ultra questions speculative scope more aggressively. Neither mode weakens safety or overrides explicit requirements. The owner can also turn this built-in skill off for the whole agent in Skills.

Do not apply these coding rules to unrelated conversation.`,
};

const ponytailReview: Skill = {
  name: 'ponytail-review',
  description:
    'Use for a read-only review of a code diff or a whole repository, focused on unnecessary complexity and what can be removed.',
  origin,
  instructions: `Review for over-engineering only, without editing. Read the code and its callers before judging. Rank findings by useful reduction: dead code, speculative configuration, one-implementation abstractions, wrappers that only delegate, dependencies the standard library or native platform replaces, and duplicated logic. For each, give the location, what to remove and what replaces it. Preserve security, validation, error handling, accessibility and required behavior; never call those excess. If nothing is worth removing, say so.`,
};

export const ponytailSkills: readonly Skill[] = [ponytail, ponytailReview];
