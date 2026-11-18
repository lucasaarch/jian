'use client';

import { Menu } from '@base-ui/react/menu';
import { EDITABLE_ARTIFACT_TYPES } from '@jian/contracts';
import { Ellipsis, Eye, MessageSquare, Pencil, Trash2 } from 'lucide-react';
import { KindIcon, kindName } from '../../components/sessions/artifacts/kind';
import { iconButton, MenuDivider, MenuEntry, menuPopup, StatusPill, surfaceCard } from '../../kit';
import type { ProfileArtifact } from '../../lib/api';
import { ago } from '../../lib/format';

/**
 * The agent's Artifacts as rows, the one changed last first: what kind each is, its name, its
 * version, the conversation it was made in and when it last changed. A row opens it; what else
 * is done to it is behind one menu at its end. Who reads it is changed only inside the opened
 * Artifact. The hover is the row's, so the time and the menu sit on the same ground.
 */
export function ArtifactsList({
  artifacts,
  empty,
  conversation,
  onOpen,
  onEdit,
  onGo,
  onDelete,
}: {
  artifacts: ProfileArtifact[];
  /** What to say when there are none to show. */
  empty: string;
  /** The name of the conversation one was made in. */
  conversation: (artifact: ProfileArtifact) => string;
  onOpen: (artifact: ProfileArtifact) => void;
  onEdit: (artifact: ProfileArtifact) => void;
  onGo: (artifact: ProfileArtifact) => void;
  onDelete: (artifact: ProfileArtifact) => void;
}) {
  return (
    <ul
      aria-label="Artifacts"
      className={`min-w-0 divide-y divide-glass-edge overflow-hidden ${surfaceCard}`}
    >
      {artifacts.map((artifact) => (
        <li
          key={artifact.id}
          className="flex min-w-0 items-center gap-0.5 pr-2 transition-colors focus-within:bg-glass-press hover:bg-glass-press"
        >
          <button
            type="button"
            aria-label={`Open ${artifact.title}`}
            onClick={() => onOpen(artifact)}
            className="flex min-w-0 flex-1 items-center gap-3 py-3 pr-2 pl-4 text-left focus-visible:outline-none"
          >
            <KindIcon artifact={artifact} />
            <span className="grid min-w-0 flex-1 grid-cols-1 gap-0.5">
              <span className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 truncate text-[13px] font-medium text-ink">
                  {artifact.title}
                </span>
                {artifact.visibility === 'public' && <StatusPill tone="warn">Public</StatusPill>}
              </span>
              <span className="truncate text-xs text-muted">
                {kindName(artifact)} · Version {artifact.version} · {conversation(artifact)}
              </span>
            </span>
            <time
              dateTime={artifact.updatedAt}
              className="shrink-0 text-xs text-muted tabular-nums"
            >
              {ago(artifact.updatedAt)}
            </time>
          </button>
          <Menu.Root>
            <Menu.Trigger aria-label={`Actions for ${artifact.title}`} className={iconButton}>
              <Ellipsis size={15} aria-hidden="true" />
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Positioner side="bottom" align="end" sideOffset={6} className="z-50">
                <Menu.Popup className={menuPopup}>
                  <MenuEntry icon={<Eye size={14} />} onClick={() => onOpen(artifact)}>
                    Open
                  </MenuEntry>
                  <MenuEntry icon={<MessageSquare size={14} />} onClick={() => onGo(artifact)}>
                    Go to conversation
                  </MenuEntry>
                  {EDITABLE_ARTIFACT_TYPES.includes(artifact.type) && (
                    <MenuEntry icon={<Pencil size={14} />} onClick={() => onEdit(artifact)}>
                      Edit
                    </MenuEntry>
                  )}
                  <MenuDivider />
                  <MenuEntry icon={<Trash2 size={14} />} danger onClick={() => onDelete(artifact)}>
                    Delete
                  </MenuEntry>
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </Menu.Root>
        </li>
      ))}
      {artifacts.length === 0 && <li className="px-4 py-3 text-[13px] text-muted">{empty}</li>}
    </ul>
  );
}
