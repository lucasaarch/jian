'use client';

import { Menu } from '@base-ui/react/menu';
import { Ellipsis, Folder, Pencil, Trash2 } from 'lucide-react';
import { iconButton, MenuEntry, menuPopup, ScrollStrip, Segmented } from '../../kit';
import type { ArtifactFolder } from '../../lib/api';
import { ALL, type Place } from './folders';

/**
 * Where the page is looking: all of the agent's Artifacts, or one place of them, each with how
 * many it holds. The row scrolls sideways when the places outgrow it. A folder the owner made
 * has a menu at the row's end while it is the one open, to rename it or delete it; a project's
 * is nobody's to change here, it follows the project.
 */
export function ArtifactFolders({
  places,
  at,
  onGo,
  onRename,
  onDelete,
}: {
  places: Place[];
  /** The place open now. */
  at: Place;
  onGo: (key: string) => void;
  onRename: (folder: ArtifactFolder) => void;
  onDelete: (folder: ArtifactFolder) => void;
}) {
  const { folder } = at;

  return (
    <div className="flex min-w-0 items-center gap-1">
      <ScrollStrip className="min-w-0 flex-1">
        <Segmented
          flat
          label="Folder"
          value={at.key}
          options={places.map((place) => ({
            value: place.key,
            label: place.name,
            ...(place.key === ALL ? {} : { icon: <Folder size={13} aria-hidden="true" /> }),
            ...(place.artifacts === undefined ? {} : { count: place.artifacts }),
          }))}
          onChange={onGo}
        />
      </ScrollStrip>
      {folder && (
        <Menu.Root>
          <Menu.Trigger aria-label={`Actions for folder ${folder.name}`} className={iconButton}>
            <Ellipsis size={15} aria-hidden="true" />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner side="bottom" align="end" sideOffset={6} className="z-50">
              <Menu.Popup className={menuPopup}>
                <MenuEntry icon={<Pencil size={14} />} onClick={() => onRename(folder)}>
                  Rename folder
                </MenuEntry>
                <MenuEntry icon={<Trash2 size={14} />} danger onClick={() => onDelete(folder)}>
                  Delete folder
                </MenuEntry>
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      )}
    </div>
  );
}
