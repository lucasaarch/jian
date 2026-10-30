'use client';

import { Popover } from '@base-ui/react/popover';
import { Settings2 } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * A chooser in the status bar: what is in use, and on opening, the others. Each row picks its
 * thing; the gear at its end, shown on hover or focus, opens that thing's settings instead.
 */
export function Picker({
  label,
  trigger,
  children,
  footer,
  open,
  onOpenChange,
}: {
  /** What the chooser chooses, for assistive technology: "Gateway", "Agent". */
  label: string;
  trigger: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <Popover.Root
      {...(open === undefined ? {} : { open })}
      {...(onOpenChange ? { onOpenChange } : {})}
    >
      <Popover.Trigger
        aria-label={label}
        className="flex h-7 max-w-56 items-center gap-1.5 rounded-full px-2.5 text-xs text-muted transition-colors hover:bg-glass-hover hover:text-ink data-popup-open:bg-glass-press data-popup-open:text-ink"
      >
        {trigger}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" align="start" sideOffset={8} className="z-50">
          <Popover.Popup className="glass w-72 origin-(--transform-origin) rounded-2xl p-1.5 text-sm text-ink outline-none transition-[opacity,scale] duration-150 data-ending-style:scale-[0.97] data-ending-style:opacity-0 data-starting-style:scale-[0.97] data-starting-style:opacity-0">
            <Popover.Title className="px-2.5 pt-1.5 pb-1 text-[11px] font-medium tracking-wide text-muted uppercase">
              {label}
            </Popover.Title>
            <ul className="grid max-h-80 gap-0.5 overflow-y-auto">{children}</ul>
            {footer && <div className="mt-1 border-t border-glass-edge pt-1">{footer}</div>}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** One thing in a chooser: picking it, and its settings at the end of the row. */
export function PickerRow({
  leading,
  label,
  detail,
  selected,
  onPick,
  onSettings,
  settingsLabel,
}: {
  leading?: ReactNode;
  label: string;
  detail?: string;
  selected: boolean;
  onPick: () => void;
  onSettings?: () => void;
  settingsLabel?: string;
}) {
  return (
    <li className="group relative">
      <button
        type="button"
        onClick={onPick}
        aria-current={selected ? 'true' : undefined}
        className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 pr-11 text-left transition-colors hover:bg-glass-hover aria-current:bg-glass-press"
      >
        {leading && <span className="grid size-6 shrink-0 place-items-center">{leading}</span>}
        <span className="grid min-w-0 flex-1">
          <span className="truncate">{label}</span>
          {detail && <span className="truncate text-xs text-muted">{detail}</span>}
        </span>
      </button>
      {onSettings && (
        <button
          type="button"
          onClick={onSettings}
          aria-label={settingsLabel ?? `${label} settings`}
          className="absolute top-1/2 right-1.5 grid size-7 -translate-y-1/2 place-items-center rounded-lg text-muted opacity-0 transition-[opacity,background-color] hover:bg-glass-press hover:text-ink focus-visible:opacity-100 group-hover:opacity-100"
        >
          <Settings2 size={15} />
        </button>
      )}
    </li>
  );
}

/** An action at the foot of a chooser: connect a gateway, create an agent. */
export function PickerAction({
  icon,
  children,
  onClick,
}: {
  icon: ReactNode;
  children: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-muted transition-colors hover:bg-glass-hover hover:text-ink"
    >
      <span className="grid size-6 place-items-center">{icon}</span>
      {children}
    </button>
  );
}
