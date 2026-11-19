'use client';

import { Copy, ExternalLink, Trash2 } from 'lucide-react';
import { copy } from '../../components/sessions/artifacts/source';
import type { SkillItem } from '../../components/skills/skill-items';
import { Action, MenuDivider, MenuEntry, SwitchControl } from '../../kit';
import { MoreMenu } from './plugin-page';

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
      <MoreMenu>
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
      </MoreMenu>
    </>
  );
}
