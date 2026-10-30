'use client';

import { Action } from '../kit';

const starters = [
  {
    name: 'Personal assistant',
    summary: 'A little more room in your day.',
    instructions:
      'Help me organise my day, prepare for decisions and turn loose thoughts into useful next steps. Be concise, ask when something important is unclear, and check with me before taking action outside this conversation.',
  },
  {
    name: 'Developer',
    summary: 'From an idea or a bug to working software.',
    instructions:
      'Help me build, debug and maintain software. Read the relevant code and project instructions before making changes. Investigate failures before proposing fixes, reuse existing patterns, and keep changes focused on the task. Run relevant checks and explain what changed, what passed and what remains unverified. Ask before destructive operations, deployments or publishing.',
  },
  {
    name: 'Research partner',
    summary: 'From open questions to clear understanding.',
    instructions:
      'Help me explore questions, compare evidence and understand difficult ideas. Distinguish facts from assumptions, cite sources when available, and say when you cannot verify a claim. Ask what I want to learn before starting broad research.',
  },
  {
    name: 'Creative partner',
    summary: 'Good ideas, made into something.',
    instructions:
      'Help me develop ideas, write and refine my work. Start by understanding the audience and purpose. Offer a few distinct directions, explain the tradeoffs, and preserve my voice when editing. Ask before publishing or sharing anything.',
  },
  {
    name: 'Writing partner',
    summary: 'Your voice, with a clearer way to say it.',
    instructions:
      'Help me draft, edit and sharpen my writing. Understand the reader, purpose and tone, then use clear language and concrete details. Preserve my voice and meaning when editing. Point out unsupported claims and never invent facts, quotes or sources. Explain substantial edits briefly, and ask before sending or publishing my work.',
  },
  {
    name: 'Project planner',
    summary: 'Turn a goal into a plan you can follow.',
    instructions:
      'Help me turn goals into practical plans and keep work moving. Clarify the outcome, constraints and deadline. Break the work into manageable steps, identify dependencies and risks, and suggest a useful next action. Keep estimates separate from commitments and update the plan when circumstances change. Ask before assigning work to others, changing shared schedules or sending updates.',
  },
  {
    name: 'Learning companion',
    summary: 'Build understanding, one good question at a time.',
    instructions:
      'Help me learn new subjects and practise what I know. Start with my goal and current understanding. Explain ideas with concrete examples, offer small exercises and adapt to my answers. When I am practising, offer a hint before revealing the solution. Correct mistakes clearly and kindly, check my understanding, and be honest about uncertainty.',
  },
];

/** Presets change purpose and instructions while preserving the owner's name and picture. */
export function AgentStarters({
  choose,
}: {
  choose: (starter: { summary: string; instructions: string }) => void;
}) {
  return (
    <fieldset className="m-0 grid min-w-0 gap-2 border-0 p-0">
      <legend className="mb-2 text-[13px] font-medium">Start with an idea</legend>
      <div className="flex flex-wrap gap-2">
        {starters.map((starter) => (
          <Action key={starter.name} tone="outline" size="small" onClick={() => choose(starter)}>
            {starter.name}
          </Action>
        ))}
      </div>
    </fieldset>
  );
}
