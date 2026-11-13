'use client';

import { Menu } from '@base-ui/react/menu';
import { Code, Copy, Ellipsis, Eye, FileDiff, Search, WrapText } from 'lucide-react';
import { useRef } from 'react';
import { toast } from 'sonner';
import { iconButton, MenuDivider, MenuEntry, menuPopup } from '../../../kit';

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
 * where the file changed and Changes can show it.
 */
export function FileOptions({
  path,
  text,
  mode,
  onModeChange,
  wrap,
  onWrapChange,
  onFind,
  onDiff,
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
  onDiff?: ((opener: HTMLElement) => void) | undefined;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  // Find takes the keyboard to its own field; the menu would hand it back to its button.
  const finding = useRef(false);

  return (
    <Menu.Root
      onOpenChange={(open) => {
        if (open) finding.current = false;
      }}
    >
      <Menu.Trigger ref={trigger} aria-label="File options" className={iconButton}>
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
            {wrap !== undefined && (
              <MenuEntry icon={<WrapText size={14} />} onClick={() => onWrapChange(!wrap)}>
                {wrap ? 'Stop wrapping lines' : 'Wrap lines'}
              </MenuEntry>
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
            {onDiff && (
              <MenuEntry
                icon={<FileDiff size={14} />}
                onClick={() => trigger.current && onDiff(trigger.current)}
              >
                Open diff
              </MenuEntry>
            )}
            {(mode || wrap !== undefined || onFind || onDiff) && <MenuDivider />}
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
