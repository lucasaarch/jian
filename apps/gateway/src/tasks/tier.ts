import type { SubagentTier } from '@jian/contracts';
import type { Judge } from '../decisions/service.js';

/** The spawn is waiting on this answer; past it the work goes to the middle tier. */
const TIMEOUT_MS = 1500;
/** Jev's pick must have at least this probability, or the middle tier is the safer guess. */
const THRESHOLD = 0.5;
const BRIEF_CHARS = 3000;

/**
 * How many subagents of a tier one conversation may have at work at once; the rest are refused.
 * Premium is one: it is a provider's top-priced model, used when the owner asked for it or a deep
 * worker already failed, and two of it at once is the fan-out that spent an owner's allowance in a
 * morning. Deep is three: a hard piece split further is rarely more than a plan, its build and a
 * review side by side, and every deep worker spends the same subscription window as the parent,
 * at the top of its price. Light and standard are not counted: parallel pieces belong there.
 */
export const TIER_AT_ONCE = { premium: 1, deep: 3 } as const;

/** What decides a tier, and who decided it. */
export type TierChoice = { tier: SubagentTier; tierBy: 'agent' | 'jev' | 'default' };

/**
 * How much model a subagent's work needs. The agent's own pick wins; left open, Jev reads the
 * brief. Without a confident answer — Jev off, unreachable or unsure — it is `standard`: too
 * little model for hard work costs a wrong result, too much for easy work only costs time.
 * `premium` is never among Jev's choices: it costs the owner too much to be anyone's guess.
 */
export async function chooseTier(
  judge: Judge | undefined,
  work: {
    tier?: 'auto' | SubagentTier;
    name: string;
    role: string;
    brief: string;
    repositories?: string[];
  },
): Promise<TierChoice> {
  if (work.tier && work.tier !== 'auto') return { tier: work.tier, tierBy: 'agent' };

  const answers = await judge?.(
    {
      name: work.name,
      role: work.role,
      brief: work.brief.slice(0, BRIEF_CHARS),
      repositories: work.repositories?.length ?? 0,
    },
    {
      tier: {
        type: 'choice',
        instructions:
          'How much model does the assignment in `brief`, given to a subagent named `name`, need to be done well?',
        criteria: {
          light: 'Small and well defined: one file, a lookup, a rename, a short text or a summary.',
          standard: 'A bounded change across a few files, with tests or checks to run.',
          deep: 'Several files or systems, risky to get wrong, or in need of a plan and careful reasoning.',
        },
      },
    },
    { use: 'delegation', timeoutMs: TIMEOUT_MS },
  );
  const picked = answers?.tier;

  if (
    picked?.type === 'choice' &&
    (picked.choice === 'light' || picked.choice === 'standard' || picked.choice === 'deep') &&
    (picked.probabilities[picked.choice] ?? 0) >= THRESHOLD
  ) {
    return { tier: picked.choice, tierBy: 'jev' };
  }

  return { tier: 'standard', tierBy: 'default' };
}
