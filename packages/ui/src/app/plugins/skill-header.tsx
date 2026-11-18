'use client';

import { Menu } from '@base-ui/react/menu';
import { Copy, Ellipsis, ExternalLink, ScrollText, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { copy } from '../../components/sessions/artifacts/source';
import type { SkillItem } from '../../components/skills/skill-items';
import { Action, iconButton, MenuDivider, MenuEntry, menuPopup, SwitchControl } from '../../kit';
import { VerifiedBadge } from './plugin-list';

/**
 * The head of a skill's page: its mark, the row's glyph a size up, its name with Jian's badge
 * on a built-in one, and under it whose it is and what it is for, on one line. What acts on the
 * skill stands at the right, and drops under the name where the two cannot share a line.
 */
export function SkillHeader({ item, children }: { item: SkillItem; children: ReactNode }) {
  return (
    <header className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-3">
      <span
        aria-hidden="true"
        className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-glass-edge bg-ink/5 text-ink"
      >
        <ScrollText size={20} />
      </span>
      <div className="grid min-w-0 flex-1 basis-48 grid-cols-1 gap-0.5">
        <h1
          id="skill-title"
          className="flex min-w-0 items-center gap-2 text-xl font-semibold tracking-tight text-ink"
        >
          <span className="min-w-0 truncate">{item.name}</span>
          {item.kind === 'built-in' && <VerifiedBadge />}
        </h1>
        <p className="truncate text-sm text-muted">
          {item.by} · {item.description}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </header>
  );
}

/**
 * What a skill's page does with it, each in the toolbar's one box, 2rem tall: the switch that
 * offers it to every agent or to none, Edit for one of the library's, and the rest behind one
 * button. A built-in skill is only switched and copied: it is Jian's to write.
 */
export function SkillActions({
  item,
  busy,
  onSwitch,
  onEdit,
  onDelete,
}: {
  item: SkillItem;
  busy: boolean;
  onSwitch: (on: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const source = item.held?.origin?.url;

  return (
    <>
      <div className="flex h-8 items-center gap-2 rounded-lg border border-glass-edge bg-glass-hover px-2.5 text-[13px] text-ink">
        <span aria-hidden="true">{item.enabled ? 'On' : 'Off'}</span>
        <SwitchControl
          label="On for every agent"
          checked={item.enabled}
          onCheckedChange={onSwitch}
        />
      </div>
      {item.held && (
        <Action tone="outline" size="field" onClick={onEdit}>
          Edit
        </Action>
      )}
      <Menu.Root>
        {/* The bar's round button, in a box as tall as its neighbours so the row stays one line. */}
        <span className="grid size-8 place-items-center">
          <Menu.Trigger aria-label="More" className={iconButton}>
            <Ellipsis size={16} aria-hidden="true" />
          </Menu.Trigger>
        </span>
        <Menu.Portal>
          <Menu.Positioner side="bottom" align="end" sideOffset={6} className="z-50">
            <Menu.Popup className={`${menuPopup} min-w-48`}>
              <MenuEntry
                icon={<Copy size={14} />}
                onClick={() => void copy(item.instructions, 'Instructions')}
              >
                Copy instructions
              </MenuEntry>
              {source && (
                <MenuEntry
                  icon={<ExternalLink size={14} />}
                  onClick={() => window.open(source, '_blank', 'noopener,noreferrer')}
                >
                  Open on GitHub
                </MenuEntry>
              )}
              {item.held && (
                <>
                  <MenuDivider />
                  <MenuEntry icon={<Trash2 size={14} />} danger disabled={busy} onClick={onDelete}>
                    Delete
                  </MenuEntry>
                </>
              )}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </>
  );
}

/** While the skill is edited in the page: leave it as it was, or keep what the form says. */
export function SkillEditActions({
  form,
  busy,
  onCancel,
}: {
  /** The id of the form Save sends, which is drawn below the header. */
  form: string;
  busy: boolean;
  onCancel: () => void;
}) {
  return (
    <>
      <Action tone="quiet" size="field" onClick={onCancel}>
        Cancel
      </Action>
      <Action tone="primary" size="field" type="submit" form={form} busy={busy}>
        Save
      </Action>
    </>
  );
}
