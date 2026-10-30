'use client';

import { Markdown } from '../../components/ui/markdown';
import { Action, Overlay, StatusPill } from '../../kit';
import type { BuiltinSkill } from '../../lib/api';

/** A skill's instructions as the agent reads them, rendered. */
export function SkillInstructions({ text }: { text: string }) {
  return (
    <div className="markdown max-h-[50dvh] overflow-y-auto rounded-xl border border-glass-edge bg-glass-hover px-3.5 py-3 text-sm leading-relaxed">
      <Markdown text={text} />
    </div>
  );
}

/**
 * A built-in skill, to read. The owner cannot edit one, so its instructions are shown in full:
 * what an agent was told has to be readable by the person answering for it.
 */
export function SkillReading({
  skill,
  enabled,
  open,
  onOpenChange,
}: {
  /** Kept while the dialog fades out, so it closes as it was. */
  skill: BuiltinSkill | undefined;
  enabled: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Overlay open={open} onOpenChange={onOpenChange} title={skill?.name ?? 'Skill'} size="page">
      {skill && (
        <div className="grid w-full gap-5 p-7">
          <header className="grid gap-1.5 pr-6">
            <h2 className="flex items-center gap-2.5 text-lg font-semibold tracking-tight">
              {skill.name}
              <StatusPill>Built-in</StatusPill>
              {!enabled && <StatusPill>Off</StatusPill>}
            </h2>
            <p className="text-sm leading-relaxed text-muted">{skill.description}</p>
          </header>
          <SkillInstructions text={skill.instructions} />
          <div className="flex items-center gap-2">
            <span className="flex-1" />
            <Action tone="quiet" onClick={() => onOpenChange(false)}>
              Close
            </Action>
          </div>
        </div>
      )}
    </Overlay>
  );
}
