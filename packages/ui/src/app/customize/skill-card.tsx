'use client';

import { Menu } from '@base-ui/react/menu';
import { Ellipsis, Pencil, Trash2 } from 'lucide-react';
import type { SkillItem } from '../../components/skills/skill-items';
import { iconButton, MenuEntry, menuPopup, StatusPill, SwitchControl } from '../../kit';

/** What a skill's card and its reading can do: the agent's own are edited, a built-in switched. */
export type SkillControls = {
  onEdit: (item: SkillItem) => void;
  onRemove: (item: SkillItem) => void;
  onSwitch: (item: SkillItem, on: boolean) => void;
};

/**
 * The one control a skill has at the head of its card, in the same place for every card: the
 * switch of a built-in skill, which the owner cannot change, or the menu of one of the agent's own.
 */
function SkillCardControl({
  item,
  onEdit,
  onRemove,
  onSwitch,
}: SkillControls & { item: SkillItem }) {
  if (item.kind === 'built-in')
    return (
      <SwitchControl
        label={item.name}
        checked={item.enabled}
        onCheckedChange={(on) => onSwitch(item, on)}
      />
    );

  return (
    <Menu.Root>
      <Menu.Trigger aria-label={`Actions for ${item.name}`} className={`${iconButton} -mr-1.5`}>
        {/* The glyph, not its round ground, lines up with the switch's edge on the cards beside it. */}
        <Ellipsis size={16} aria-hidden="true" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={6} className="z-50">
          <Menu.Popup className={menuPopup}>
            <MenuEntry icon={<Pencil size={14} />} onClick={() => onEdit(item)}>
              Edit
            </MenuEntry>
            <MenuEntry icon={<Trash2 size={14} />} danger onClick={() => onRemove(item)}>
              Remove
            </MenuEntry>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/**
 * A skill as a card: name, what it is for, and where it came from. The whole card opens it to
 * read, through its name; the control above stays pressable on its own.
 */
export function SkillCard({
  item,
  onOpen,
  ...controls
}: SkillControls & { item: SkillItem; onOpen: (item: SkillItem) => void }) {
  return (
    <article className="relative flex min-w-0 flex-col gap-2 rounded-xl border border-glass-edge bg-glass-hover p-4 transition-colors focus-within:border-ink/20 hover:bg-glass-press">
      {/* 1.75rem, the height of both controls, so a card with a switch and one with a menu match. */}
      <header className="flex h-7 min-w-0 items-center gap-2">
        <h3 className="min-w-0 flex-1 text-[13px] font-medium text-ink">
          <button
            type="button"
            aria-label={`Read ${item.name}`}
            onClick={() => onOpen(item)}
            // Stretched over the card, under the control, which is raised above it.
            className="block max-w-full truncate text-left outline-none after:absolute after:inset-0 after:rounded-xl"
          >
            {item.name}
          </button>
        </h3>
        <span className="relative z-10 flex shrink-0 items-center">
          <SkillCardControl item={item} {...controls} />
        </span>
      </header>
      <p className="line-clamp-3 text-xs leading-snug text-muted">{item.description}</p>
      <footer className="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
        <StatusPill>{item.source}</StatusPill>
        {!item.enabled && <StatusPill tone="warn">Off</StatusPill>}
      </footer>
    </article>
  );
}
