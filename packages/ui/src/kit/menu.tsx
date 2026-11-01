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
  disabled = false,
}: {
  icon?: ReactNode;
  children: ReactNode;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <Menu.Item
      onClick={onClick}
      disabled={disabled}
      className={`flex h-8 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 outline-none select-none data-disabled:pointer-events-none data-disabled:opacity-45 data-highlighted:bg-glass-press ${danger ? 'text-bad' : ''}`}
    >
      {icon && <span className="grid size-4 place-items-center text-current">{icon}</span>}
      {children}
    </Menu.Item>
  );
}

/** A line between groups of a menu's entries. */
export function MenuDivider() {
  return <Menu.Separator className="mx-2 my-1 h-px bg-glass-edge" />;
}
