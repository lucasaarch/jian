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
import type { ArtifactFolder, ProfileArtifact, SessionArtifact } from '../../lib/api';
import { ago } from '../../lib/format';
import { gatewayOrigin } from '../../platform/gateway';
import { ArtifactThumbnail } from './artifact-thumbnail';

/** What the Artifacts page asks to be done with one of its cards' Artifact. */
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

/** What a card's corner does to its Artifact, each already bound to it. */
export type CardTools = {
  rename: () => void;
  duplicate: () => void;
  delete: () => void;
  /**
   * How the Artifacts page keeps it: its pin, its folder and the way to its conversation. The
   * Inspector's cards have none: they are in that conversation already, and the page keeps them.
   */
  keeping?: {
    pinned: boolean;
    pin: () => void;
    go: () => void;
    /** The owner's folder it is in; null where it started, which `home` names. */
    folderId: string | null;
    folders: ArtifactFolder[];
    home: string;
    move: (folderId: string | null) => void;
    moveToNew: () => void;
  };
};

/**
 * One Artifact as a card, on the Artifacts page and in the Inspector alike: its picture, its
 * name, its kind and when it last changed. The whole card opens it, through one button laid
 * over it, so the picture under it is never what a click reaches. Its tools come up in a corner
 * while the pointer or the focus is on the card, and are always there on a phone, which has no
 * hover. Who reads it is changed only inside the opened Artifact; a public one says so.
 */
export function ArtifactCard({
  api,
  profileId,
  artifact,
  onOpen,
  tools,
}: {
  api: ArtifactsApi;
  profileId: string;
  artifact: SessionArtifact;
  onOpen: () => void;
  tools: CardTools;
}) {
  const link =
    artifact.visibility === 'public' && artifact.publicPath
      ? `${gatewayOrigin()}${artifact.publicPath}`
      : undefined;
  const { keeping } = tools;

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
        onClick={onOpen}
        className="absolute inset-0 rounded-[inherit] outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-inset"
      />
      <div className="glass absolute top-2 right-2 flex items-center gap-0.5 rounded-full p-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 has-[[data-popup-open]]:opacity-100 phone:opacity-100">
        {keeping && (
          <button
            type="button"
            aria-label={`${keeping.pinned ? 'Unpin' : 'Pin'} ${artifact.title}`}
            aria-pressed={keeping.pinned}
            onClick={keeping.pin}
            className={iconButton}
          >
            {keeping.pinned ? (
              <PinOff size={15} aria-hidden="true" />
            ) : (
              <Pin size={15} aria-hidden="true" />
            )}
          </button>
        )}
        <Menu.Root>
          <Menu.Trigger aria-label={`Actions for ${artifact.title}`} className={iconButton}>
            <Ellipsis size={15} aria-hidden="true" />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner side="bottom" align="end" sideOffset={6} className="z-50">
              <Menu.Popup className={menuPopup}>
                {keeping && (
                  <MenuEntry
                    icon={keeping.pinned ? <PinOff size={14} /> : <Pin size={14} />}
                    onClick={keeping.pin}
                  >
                    {keeping.pinned ? 'Unpin' : 'Pin'}
                  </MenuEntry>
                )}
                <MenuEntry icon={<Pencil size={14} />} onClick={tools.rename}>
                  Rename
                </MenuEntry>
                <MenuEntry icon={<Copy size={14} />} onClick={tools.duplicate}>
                  Duplicate
                </MenuEntry>
                {link && (
                  <MenuEntry icon={<Link size={14} />} onClick={() => void copy(link, 'Link')}>
                    Copy link
                  </MenuEntry>
                )}
                {keeping && (
                  <>
                    <MenuEntry icon={<MessageSquare size={14} />} onClick={keeping.go}>
                      Open conversation
                    </MenuEntry>
                    <MenuSubmenu icon={<FolderInput size={14} />} label="Move to folder">
                      {/* Where it is now is ticked, and is no move to make. */}
                      <MenuEntry
                        icon={keeping.folderId ? <Folder size={14} /> : <Check size={14} />}
                        disabled={!keeping.folderId}
                        onClick={() => keeping.move(null)}
                      >
                        {keeping.home}
                      </MenuEntry>
                      {keeping.folders.map((folder) => (
                        <MenuEntry
                          key={folder.id}
                          icon={
                            keeping.folderId === folder.id ? (
                              <Check size={14} />
                            ) : (
                              <Folder size={14} />
                            )
                          }
                          disabled={keeping.folderId === folder.id}
                          onClick={() => keeping.move(folder.id)}
                        >
                          <span className="min-w-0 truncate">{folder.name}</span>
                        </MenuEntry>
                      ))}
                      <MenuDivider />
                      <MenuEntry icon={<FolderPlus size={14} />} onClick={keeping.moveToNew}>
                        New folder…
                      </MenuEntry>
                    </MenuSubmenu>
                  </>
                )}
                <MenuDivider />
                <MenuEntry icon={<Trash2 size={14} />} danger onClick={tools.delete}>
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
