'use client';

import { Menu } from '@base-ui/react/menu';
import { Code, Copy, Ellipsis, Eye, FileDiff, Search, WrapText } from 'lucide-react';
import { useRef } from 'react';
import { toast } from 'sonner';
import { iconButton, MenuDivider, MenuEntry, MenuSwitch, menuPopup } from '../../../kit';

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied.`);
  } catch {
    toast.error(`The ${what.toLowerCase()} could not be copied.`);
  }
}

/**
 * Everything the open file's bar can do, behind its one button. An entry shows only where it
 * applies: the way to read a Markdown page, wrapping and finding where there is text, the diff
 * where the file changed and its checkout can be compared. The ways of showing it are switches,
 * and the menu stays open over them so the change shows at once.
 */
export function FileOptions({
  path,
  text,
  mode,
  onModeChange,
  wrap,
  onWrapChange,
  onFind,
  diff,
  onDiffChange,
}: {
  path: string;
  /** The file's text, once it is read and can be shown. */
  text?: string | undefined;
  /** How a Markdown page is read; absent for any other file. */
  mode?: 'preview' | 'code' | undefined;
  onModeChange: (mode: 'preview' | 'code') => void;
  /** Whether long lines wrap; absent while there are no lines on screen. */
  wrap?: boolean | undefined;
  onWrapChange: (wrap: boolean) => void;
  onFind?: (() => void) | undefined;
  /** Whether the file's change is laid into it; absent where it has none to show. */
  diff?: boolean | undefined;
  onDiffChange: (diff: boolean) => void;
}) {
  // Find takes the keyboard to its own field; the menu would hand it back to its button.
  const finding = useRef(false);

  return (
    <Menu.Root
      onOpenChange={(open) => {
        if (open) finding.current = false;
      }}
    >
      <Menu.Trigger aria-label="File options" className={iconButton}>
        <Ellipsis size={16} aria-hidden="true" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={6} className="z-50">
          <Menu.Popup className={`${menuPopup} min-w-52`} finalFocus={() => !finding.current}>
            {mode === 'preview' && (
              <MenuEntry icon={<Code size={14} />} onClick={() => onModeChange('code')}>
                Show code
              </MenuEntry>
            )}
            {mode === 'code' && (
              <MenuEntry icon={<Eye size={14} />} onClick={() => onModeChange('preview')}>
                Show preview
              </MenuEntry>
            )}
            {diff !== undefined && (
              <MenuSwitch
                icon={<FileDiff size={14} />}
                checked={diff}
                onCheckedChange={onDiffChange}
              >
                View diff
              </MenuSwitch>
            )}
            {wrap !== undefined && (
              <MenuSwitch
                icon={<WrapText size={14} />}
                checked={wrap}
                onCheckedChange={onWrapChange}
              >
                Wrap lines
              </MenuSwitch>
            )}
            {onFind && (
              <MenuEntry
                icon={<Search size={14} />}
                onClick={() => {
                  finding.current = true;
                  onFind();
                }}
              >
                Find in file
              </MenuEntry>
            )}
            {(mode || wrap !== undefined || onFind || diff !== undefined) && <MenuDivider />}
            <MenuEntry icon={<Copy size={14} />} onClick={() => void copy(path, 'Path')}>
              Copy path
            </MenuEntry>
            {text !== undefined && (
              <MenuEntry icon={<Copy size={14} />} onClick={() => void copy(text, 'Contents')}>
                Copy contents
              </MenuEntry>
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
