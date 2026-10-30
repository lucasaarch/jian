import type { DecisionsStatus } from '../../lib/api/types';

export type DecisionUse = keyof DecisionsStatus['uses'];

/** Each judgement Jev can make, which the owner switches between it and the fixed rule. */
export const decisionUses: Array<{ use: DecisionUse; title: string; what: string }> = [
  {
    use: 'outside',
    title: 'Outside content',
    what: 'Pages, searches and service results that try to give the agent orders.',
  },
  {
    use: 'turn',
    title: 'Each turn',
    what: 'The memories and skill that fit it, and less thinking on plainly light ones.',
  },
  {
    use: 'memories',
    title: 'Repeated memories',
    what: 'A new memory about a subject already kept.',
  },
  {
    use: 'learning',
    title: 'Learning',
    what: 'Skips the look-back when work holds nothing to keep.',
  },
  { use: 'groups', title: 'Groups', what: 'Whether a group message is speaking to an agent.' },
  {
    use: 'delegation',
    title: 'Subagent models',
    what: 'How much model a subagent needs, when the agent leaves it open.',
  },
  {
    use: 'replies',
    title: 'Chat replies',
    what: 'What a reply in WhatsApp or Telegram means for an approval or a question.',
  },
  {
    use: 'guardrail',
    title: 'Guardrail',
    what: 'In a conversation on Auto, whether an action is catastrophic enough to refuse.',
  },
];

/** What switching one use says once it is saved. */
export const decisionSwitched = (title: string, on: boolean) =>
  `${title} ${on ? 'asks Jev' : 'uses the fixed rule'}.`;
