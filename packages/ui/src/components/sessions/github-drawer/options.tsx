'use client';

import { Menu } from '@base-ui/react/menu';
import {
  ChevronsDownUp,
  ChevronsUpDown,
  Ellipsis,
  ExternalLink,
  Link,
  RefreshCw,
} from 'lucide-react';
import { toast } from 'sonner';
import { MenuDivider, MenuEntry, MenuToggle, menuPopup } from '../../../kit/menu';
import { barButton } from '../inspector';

/**
 * What can be done with the item the drawer follows, behind one button: how its diffs read, its
 * parts folded or opened at once, reading it again, and reaching it on GitHub.
 */
export function DrawerOptions({
  url,
  diffs,
  wrap,
  setWrap,
  folded,
  fold,
  refresh,
}: {
  url: string;
  /** Whether it shows code changes, which wrapping lines is about. */
  diffs: boolean;
  wrap: boolean;
  setWrap: (wrap: boolean) => void;
  /** Whether everything was last asked to fold, so the entry offers the other way. */
  folded: boolean;
  fold: (open: boolean) => void;
  refresh: () => void;
}) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Link copied.');
    } catch {
      toast.error('The link could not be copied.');
    }
  };

  return (
    <Menu.Root>
      <Menu.Trigger aria-label="Options" className={barButton}>
        <Ellipsis size={16} aria-hidden="true" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={6} className="z-50">
          <Menu.Popup className={`${menuPopup} min-w-52`}>
            {diffs && (
              <>
                <MenuToggle checked={wrap} onCheckedChange={setWrap}>
                  Word wrap
                </MenuToggle>
                <MenuDivider />
              </>
            )}
            {folded ? (
              <MenuEntry icon={<ChevronsUpDown size={14} />} onClick={() => fold(true)}>
                Expand all
              </MenuEntry>
            ) : (
              <MenuEntry icon={<ChevronsDownUp size={14} />} onClick={() => fold(false)}>
                Collapse all
              </MenuEntry>
            )}
            <MenuEntry icon={<RefreshCw size={14} />} onClick={refresh}>
              Refresh
            </MenuEntry>
            <MenuDivider />
            <MenuEntry
              icon={<ExternalLink size={14} />}
              onClick={() => window.open(url, '_blank', 'noopener,noreferrer')}
            >
              Open on GitHub
            </MenuEntry>
            <MenuEntry icon={<Link size={14} />} onClick={() => void copy()}>
              Copy link
            </MenuEntry>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
