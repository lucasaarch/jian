'use client';

import { Tooltip } from '@base-ui/react/tooltip';
import { Info } from 'lucide-react';

/** A small "i" that says a little more under the pointer or the keyboard's focus. */
export function InfoTip({ label, children }: { label: string; children: string }) {
  return (
    <Tooltip.Provider delay={150}>
      <Tooltip.Root>
        <Tooltip.Trigger
          aria-label={label}
          className="grid size-4 shrink-0 place-items-center rounded-full text-muted/60 transition-colors hover:text-muted"
        >
          <Info size={13} aria-hidden="true" />
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Positioner side="top" sideOffset={6} className="z-[70]">
            <Tooltip.Popup className="glass-strong max-w-60 origin-(--transform-origin) rounded-lg px-2.5 py-1.5 text-xs text-ink transition-[opacity,scale] duration-100 data-ending-style:scale-[0.97] data-ending-style:opacity-0 data-starting-style:scale-[0.97] data-starting-style:opacity-0">
              {children}
            </Tooltip.Popup>
          </Tooltip.Positioner>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
