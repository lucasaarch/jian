'use client';

import { Menu } from '@base-ui/react/menu';
import { History } from 'lucide-react';
import { iconButton, MenuChoices, menuPopup } from '../../../kit';

/**
 * The versions of the open Artifact, behind one button of its bar: every one it has had, the
 * newest first and marked, the one in view ticked. Picking one shows it; picking the latest goes
 * back to following the agent's updates (artifact-view.tsx).
 */
export function ArtifactHistory({
  latest,
  version,
  onPick,
}: {
  /** The newest version, which is also how many there are: they count from 1. */
  latest: number;
  /** The version in view. */
  version: number;
  onPick: (version: number) => void;
}) {
  const versions = Array.from({ length: latest }, (_, index) => ({
    value: String(latest - index),
    label: `Version ${latest - index}`,
    ...(index === 0 ? { detail: 'latest' } : {}),
  }));

  return (
    <Menu.Root>
      <Menu.Trigger aria-label="History" className={iconButton}>
        <History size={15} aria-hidden="true" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={6} className="z-50">
          <Menu.Popup
            className={`${menuPopup} scroll-inset max-h-[min(20rem,var(--available-height))] overflow-y-auto`}
          >
            <MenuChoices
              label="Version"
              value={String(version)}
              options={versions}
              onValueChange={(next) => onPick(Number(next))}
            />
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
