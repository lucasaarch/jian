'use client';

import { Menu } from '@base-ui/react/menu';
import { Columns2, Copy, Heading, List, Plus, Square, Type } from 'lucide-react';
import type { ReactNode } from 'react';
import { iconButton, MenuDivider, MenuEntry, menuPopup } from '../../../../kit';
import { LAYOUTS, type SlideLayout } from './layouts';
import type { NewSlide } from './use-slide-ops';

const ICON: Record<SlideLayout, ReactNode> = {
  title: <Type size={14} />,
  text: <List size={14} />,
  columns: <Columns2 size={14} />,
  section: <Heading size={14} />,
  blank: <Square size={14} />,
};

/** The entries that add a slide: each layout in the deck's look, then a copy of the one named. */
export function NewSlideEntries({ onAdd }: { onAdd: (what: NewSlide) => void }) {
  return (
    <>
      {LAYOUTS.map(({ layout, label }) => (
        <MenuEntry key={layout} icon={ICON[layout]} onClick={() => onAdd(layout)}>
          {label}
        </MenuEntry>
      ))}
      <MenuDivider />
      <MenuEntry icon={<Copy size={14} />} onClick={() => onAdd('duplicate')}>
        Duplicate current
      </MenuEntry>
    </>
  );
}

/** The rail's way to a new slide, after the one in view: a button opening the layouts. */
export function AddSlide({
  onAdd,
  disabled,
}: {
  onAdd: (what: NewSlide) => void;
  disabled: boolean;
}) {
  return (
    <Menu.Root>
      <Menu.Trigger aria-label="New slide" disabled={disabled} className={iconButton}>
        <Plus size={16} aria-hidden="true" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="bottom" align="end" sideOffset={6} className="z-50">
          <Menu.Popup className={`${menuPopup} min-w-48`}>
            <NewSlideEntries onAdd={onAdd} />
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
