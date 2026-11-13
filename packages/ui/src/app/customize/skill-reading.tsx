'use client';

import { Pencil } from 'lucide-react';
import type { SkillItem } from '../../components/skills/skill-items';
import { Markdown } from '../../components/ui/markdown';
import { Action, PageHeading, StatusPill, SwitchControl, surfaceCard } from '../../kit';
import type { SkillControls } from './skill-card';

/** A skill's instructions as the agent reads them, rendered. */
export function SkillInstructions({ text, tall = false }: { text: string; tall?: boolean }) {
  return (
    <div
      className={`markdown overflow-y-auto ${surfaceCard} px-4 py-3.5 text-sm leading-relaxed ${tall ? '' : 'max-h-[50dvh]'}`}
    >
      <Markdown text={text} />
    </div>
  );
}

/**
 * One skill to read, in place of the cards: what the agent is told, rendered as Markdown. The
 * owner cannot edit a built-in skill, so its instructions are shown in full: what an agent was
 * told has to be readable by the person answering for it. One of the agent's own is edited from
 * here, in the form it always had.
 */
export function SkillReading({
  item,
  onBack,
  onEdit,
  onSwitch,
}: Pick<SkillControls, 'onEdit' | 'onSwitch'> & { item: SkillItem; onBack: () => void }) {
  return (
    <section aria-label={item.name} className="grid min-w-0 grid-cols-1 gap-4">
      <PageHeading
        onBack={onBack}
        backLabel="Back to skills"
        title={
          <>
            <span className="truncate">{item.name}</span>
            <StatusPill>{item.source}</StatusPill>
            {!item.enabled && <StatusPill tone="warn">Off</StatusPill>}
          </>
        }
        description={item.description}
        actions={
          item.kind === 'built-in' ? (
            <SwitchControl
              label={item.name}
              checked={item.enabled}
              onCheckedChange={(on) => onSwitch(item, on)}
            />
          ) : (
            <Action tone="outline" size="small" className="h-8" onClick={() => onEdit(item)}>
              <Pencil size={13} />
              Edit
            </Action>
          )
        }
      />
      <SkillInstructions text={item.instructions} tall />
    </section>
  );
}
