'use client';

import { type SkillItem, skillMeta } from '../../components/skills/skill-items';
import { Markdown } from '../../components/ui/markdown';
import { Action, Overlay, OverlayActions, SettingsGroup, surfaceCard, Toggle } from '../../kit';
import { VerifiedBadge } from './plugin-list';

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
 * One skill, opened from its row: whose it is, the switch that offers it to every agent or to
 * none, and what the agents are told, rendered as Markdown. The owner cannot edit a built-in
 * skill, so its instructions are shown in full: what an agent was told has to be readable by the
 * person answering for it. One of the library's is edited and deleted from here, whoever wrote
 * it. `item` stays set while this closes, so it fades out as it was.
 */
export function SkillReadingDialog({
  item,
  open,
  onOpenChange,
  busy,
  onSwitch,
  onEdit,
  onDelete,
}: {
  item: SkillItem | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  busy: boolean;
  onSwitch: (item: SkillItem, on: boolean) => void;
  onEdit: (item: SkillItem) => void;
  onDelete: (item: SkillItem) => void;
}) {
  return (
    <Overlay open={open} onOpenChange={onOpenChange} title={item?.name ?? 'Skill'} size="page">
      {item && (
        <div className="grid w-full grid-cols-1 gap-5 p-7">
          <header className="grid grid-cols-1 gap-1 pr-10">
            <h2 className="flex min-w-0 items-center gap-2 text-lg font-semibold tracking-tight">
              <span className="min-w-0 truncate">{item.name}</span>
              {item.kind === 'built-in' && <VerifiedBadge />}
            </h2>
            <p className="text-sm text-muted">{skillMeta(item)}</p>
            <p className="text-sm text-muted">{item.description}</p>
          </header>
          <SettingsGroup>
            <Toggle
              label="On for every agent"
              detail={item.enabled ? 'Every agent is offered it.' : 'No agent is offered it.'}
              checked={item.enabled}
              onCheckedChange={(on) => onSwitch(item, on)}
            />
          </SettingsGroup>
          <SkillInstructions text={item.instructions} tall />
          {item.kind !== 'built-in' && (
            <OverlayActions>
              <Action
                tone="danger"
                className="bg-bad/10"
                disabled={busy}
                onClick={() => onDelete(item)}
              >
                Delete
              </Action>
              <span className="flex-1" />
              <Action tone="outline" onClick={() => onEdit(item)}>
                Edit
              </Action>
            </OverlayActions>
          )}
        </div>
      )}
    </Overlay>
  );
}
