'use client';

import { Menu } from '@base-ui/react/menu';
import { COMPONENT_PROMPT_TARGETS, componentPrompt } from '@jian/contracts';
import { Copy, Download, Ellipsis, Sparkles } from 'lucide-react';
import { iconButton, MenuEntry, MenuSubmenu, menuPopup } from '../../../kit';
import { copy, download } from './source';

/**
 * What else the open Artifact's bar can do, behind its one button: take its source away, as
 * text or as a file. For a deck that is the slide in view, which is the page being read, and
 * only as text: a deck's files have a menu of their own (deck/deck-download.tsx). A component
 * is also copied as a prompt for another AI, to use it as it is or in another framework: the
 * same prompt its public page copies.
 */
export function ArtifactOptions({
  source,
  file,
  what,
  component,
}: {
  /** The source as written; undefined until it is read. */
  source: string | undefined;
  /** The name it downloads as; with none it is not downloaded from here. */
  file?: string;
  /** What is copied, as the owner is told: "Source", or "Slide". */
  what: string;
  /** A React component's title, which its prompts are headed by; absent for every other type. */
  component?: string;
}) {
  return (
    <Menu.Root>
      <Menu.Trigger aria-label="Artifact options" className={iconButton}>
        <Ellipsis size={16} aria-hidden="true" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={6} className="z-50">
          <Menu.Popup className={`${menuPopup} min-w-48`}>
            <MenuEntry
              icon={<Copy size={14} />}
              disabled={source === undefined}
              onClick={() => source !== undefined && void copy(source, what)}
            >
              Copy source
            </MenuEntry>
            {component !== undefined && source !== undefined && (
              <MenuSubmenu icon={<Sparkles size={14} />} label="Copy prompt for">
                {COMPONENT_PROMPT_TARGETS.map((target) => (
                  <MenuEntry
                    key={target.id}
                    onClick={() =>
                      void copy(componentPrompt(target.id, { title: component, source }), 'Prompt')
                    }
                  >
                    {target.label}
                  </MenuEntry>
                ))}
              </MenuSubmenu>
            )}
            {file !== undefined && (
              <MenuEntry
                icon={<Download size={14} />}
                disabled={source === undefined}
                onClick={() => source !== undefined && download(file, source)}
              >
                Download
              </MenuEntry>
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
