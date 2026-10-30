'use client';

import { Menu } from '@base-ui/react/menu';
import type { ReactNode } from 'react';

/** The popup every menu of the kit is drawn in, from a button or a right click alike. */
export const menuPopup =
  'glass min-w-44 origin-(--transform-origin) rounded-xl p-1 text-[13px] text-ink outline-none transition-[opacity,scale] duration-100 data-ending-style:scale-[0.97] data-ending-style:opacity-0 data-starting-style:scale-[0.97] data-starting-style:opacity-0';

/**
 * One thing a menu does. A `danger` entry is what cannot be taken back. It works inside a
 * context menu too, whose items are the same.
 */
export function MenuEntry({
  icon,
  children,
  onClick,
  danger = false,
}: {
  icon?: ReactNode;
  children: ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <Menu.Item
      onClick={onClick}
      className={`flex h-8 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 outline-none select-none data-highlighted:bg-glass-press ${danger ? 'text-bad' : ''}`}
    >
      {icon && <span className="grid size-4 place-items-center text-current">{icon}</span>}
      {children}
    </Menu.Item>
  );
}

/**
 * A setting turned on and off from a menu, its switch at the end of the line. The menu stays
 * open, so the change can be seen and turned back.
 */
export function MenuToggle({
  children,
  checked,
  onCheckedChange,
}: {
  children: ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <Menu.CheckboxItem
      checked={checked}
      onCheckedChange={onCheckedChange}
      closeOnClick={false}
      className="group flex h-8 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 outline-none select-none data-highlighted:bg-glass-press"
    >
      <span className="flex-1">{children}</span>
      {/* The kit's switch, drawn small and moving alike: the line itself is what is pressed. */}
      <span
        aria-hidden="true"
        className="inline-flex h-4 w-6.5 shrink-0 items-center rounded-full bg-ink/20 p-0.5 transition-colors duration-[350ms] ease-[cubic-bezier(0.65,0,0.35,1)] group-data-checked:bg-ink"
      >
        <span className="block size-3 rounded-full bg-ink transition-[translate,background-color] duration-[350ms] ease-[cubic-bezier(0.65,0,0.35,1)] group-data-checked:translate-x-2.5 group-data-checked:bg-canvas" />
      </span>
    </Menu.CheckboxItem>
  );
}

/** A line between groups of a menu's entries. */
export function MenuDivider() {
  return <Menu.Separator className="mx-2 my-1 h-px bg-glass-edge" />;
}
