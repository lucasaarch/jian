'use client';

import { Menu } from '@base-ui/react/menu';
import {
  Check,
  Copy,
  Ellipsis,
  Folder,
  FolderInput,
  FolderPlus,
  Link,
  MessageSquare,
  Pencil,
  Pin,
  PinOff,
  Trash2,
} from 'lucide-react';
import { kindName } from '../../components/sessions/artifacts/kind';
import { copy } from '../../components/sessions/artifacts/source';
import type { ArtifactsApi } from '../../components/sessions/artifacts/use-artifacts';
import {
  iconButton,
  MenuDivider,
  MenuEntry,
  MenuSubmenu,
  menuPopup,
  StatusPill,
  surfaceCard,
} from '../../kit';
import type { ArtifactFolder, ProfileArtifact } from '../../lib/api';
import { ago } from '../../lib/format';
import { gatewayOrigin } from '../../platform/gateway';
import { ArtifactThumbnail } from './artifact-thumbnail';

/** What a card asks the page to do with its Artifact. */
export type CardActions = {
  open: (artifact: ProfileArtifact) => void;
  /** Pins one that is not, and the other way round. */
  pin: (artifact: ProfileArtifact) => void;
  rename: (artifact: ProfileArtifact) => void;
  duplicate: (artifact: ProfileArtifact) => void;
  /** To the conversation it was made in. */
  go: (artifact: ProfileArtifact) => void;
  /** To a folder of the owner's, or with `null` back where it started. */
  move: (artifact: ProfileArtifact, folderId: string | null) => void;
  /** To a folder made for it now. */
  moveToNew: (artifact: ProfileArtifact) => void;
  delete: (artifact: ProfileArtifact) => void;
};

/**
 * One Artifact as a card: its picture, its name, its kind and when it last changed. The whole
 * card opens it, through one button laid over it, so the picture under it is never what a click
 * reaches. Its pin and the menu of everything else done to it come up in a corner while the
 * pointer or the focus is on the card, and are always there on a phone, which has no hover. Who
 * reads it is changed only inside the opened Artifact; a public one says so.
 */
export function ArtifactCard({
  api,
  profileId,
  artifact,
  folders,
  home,
  on,
}: {
  api: ArtifactsApi;
  profileId: string;
  artifact: ProfileArtifact;
  /** The owner's folders, which it can be moved to. */
  folders: ArtifactFolder[];
  /** The name of where it started. */
  home: string;
  on: CardActions;
}) {
  const link =
    artifact.visibility === 'public' && artifact.publicPath
      ? `${gatewayOrigin()}${artifact.publicPath}`
      : undefined;

  return (
    <li
      className={`group relative grid min-w-0 grid-cols-1 overflow-hidden transition-colors focus-within:bg-glass-press hover:bg-glass-press ${surfaceCard}`}
    >
      <div className="aspect-video min-w-0 overflow-hidden border-b border-glass-edge">
        <ArtifactThumbnail api={api} profileId={profileId} artifact={artifact} />
      </div>
      <div className="grid min-w-0 grid-cols-1 gap-0.5 px-3 py-2.5">
        <span className="truncate text-[13px] font-medium text-ink">{artifact.title}</span>
        <span className="flex min-w-0 items-center gap-2 text-xs text-muted">
          <span className="min-w-0 flex-1 truncate">
            {kindName(artifact)} ·{' '}
            <time dateTime={artifact.updatedAt}>{ago(artifact.updatedAt)}</time>
          </span>
          {artifact.visibility === 'public' && <StatusPill tone="warn">Public</StatusPill>}
        </span>
      </div>
      <button
        type="button"
        aria-label={`Open ${artifact.title}`}
        onClick={() => on.open(artifact)}
        className="absolute inset-0 rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-inset"
      />
      <div className="glass absolute top-2 right-2 flex items-center gap-0.5 rounded-full p-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 has-[[data-popup-open]]:opacity-100 phone:opacity-100">
        <button
          type="button"
          aria-label={`${artifact.pinned ? 'Unpin' : 'Pin'} ${artifact.title}`}
          aria-pressed={artifact.pinned}
          onClick={() => on.pin(artifact)}
          className={iconButton}
        >
          {artifact.pinned ? (
            <PinOff size={15} aria-hidden="true" />
          ) : (
            <Pin size={15} aria-hidden="true" />
          )}
        </button>
        <Menu.Root>
          <Menu.Trigger aria-label={`Actions for ${artifact.title}`} className={iconButton}>
            <Ellipsis size={15} aria-hidden="true" />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner side="bottom" align="end" sideOffset={6} className="z-50">
              <Menu.Popup className={menuPopup}>
                <MenuEntry
                  icon={artifact.pinned ? <PinOff size={14} /> : <Pin size={14} />}
                  onClick={() => on.pin(artifact)}
                >
                  {artifact.pinned ? 'Unpin' : 'Pin'}
                </MenuEntry>
                <MenuEntry icon={<Pencil size={14} />} onClick={() => on.rename(artifact)}>
                  Rename
                </MenuEntry>
                <MenuEntry icon={<Copy size={14} />} onClick={() => on.duplicate(artifact)}>
                  Duplicate
                </MenuEntry>
                {link && (
                  <MenuEntry icon={<Link size={14} />} onClick={() => void copy(link, 'Link')}>
                    Copy link
                  </MenuEntry>
                )}
                <MenuEntry icon={<MessageSquare size={14} />} onClick={() => on.go(artifact)}>
                  Open conversation
                </MenuEntry>
                <MenuSubmenu icon={<FolderInput size={14} />} label="Move to folder">
                  {/* Where it is now is ticked, and is no move to make. */}
                  <MenuEntry
                    icon={artifact.folderId ? <Folder size={14} /> : <Check size={14} />}
                    disabled={!artifact.folderId}
                    onClick={() => on.move(artifact, null)}
                  >
                    {home}
                  </MenuEntry>
                  {folders.map((folder) => (
                    <MenuEntry
                      key={folder.id}
                      icon={
                        artifact.folderId === folder.id ? <Check size={14} /> : <Folder size={14} />
                      }
                      disabled={artifact.folderId === folder.id}
                      onClick={() => on.move(artifact, folder.id)}
                    >
                      <span className="min-w-0 truncate">{folder.name}</span>
                    </MenuEntry>
                  ))}
                  <MenuDivider />
                  <MenuEntry icon={<FolderPlus size={14} />} onClick={() => on.moveToNew(artifact)}>
                    New folder…
                  </MenuEntry>
                </MenuSubmenu>
                <MenuDivider />
                <MenuEntry icon={<Trash2 size={14} />} danger onClick={() => on.delete(artifact)}>
                  Delete
                </MenuEntry>
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      </div>
    </li>
  );
}
