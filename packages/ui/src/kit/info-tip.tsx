'use client';

import { Tooltip } from '@base-ui/react/tooltip';
import { Info } from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';

const popup =
  'glass-strong origin-(--transform-origin) rounded-lg px-2.5 py-1.5 text-xs text-ink transition-[opacity,scale] duration-100 data-ending-style:scale-[0.97] data-ending-style:opacity-0 data-starting-style:scale-[0.97] data-starting-style:opacity-0';

/**
 * More words about something, on glass, under the pointer or the keyboard's focus. `children`
 * is the element it is about, which must take focus for the keyboard to reach it; `wide` is for
 * what is long, such as an error, kept as it was written, line breaks and all. `hoverOnly` is for
 * a button handed focus on its own, as an opened panel does, where a tip would open unasked. `side`
 * and `align` are for one at a window's edge, where the first choice has no room.
 */
export function HoverTip({
  tip,
  wide = false,
  hoverOnly = false,
  side = 'top',
  align = 'center',
  children,
}: {
  tip: ReactNode;
  wide?: boolean;
  hoverOnly?: boolean;
  side?: 'top' | 'bottom';
  align?: 'center' | 'end';
  children: ReactElement<Record<string, unknown>>;
}) {
  return (
    <Tooltip.Provider delay={150}>
      <Tooltip.Root
        onOpenChange={(open, details) => {
          if (hoverOnly && open && details.reason === 'trigger-focus') details.cancel();
        }}
      >
        <Tooltip.Trigger render={children} />
        <Tooltip.Portal>
          <Tooltip.Positioner side={side} align={align} sideOffset={6} className="z-[70]">
            <Tooltip.Popup
              className={`${popup} ${wide ? 'max-w-[min(28rem,calc(100vw-2rem))] whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed select-text' : 'max-w-60'}`}
            >
              {tip}
            </Tooltip.Popup>
          </Tooltip.Positioner>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}

/** A small "i" that says a little more under the pointer or the keyboard's focus. */
export function InfoTip({ label, children }: { label: string; children: string }) {
  return (
    <HoverTip tip={children}>
      <button
        type="button"
        aria-label={label}
        className="grid size-4 shrink-0 place-items-center rounded-full text-muted/60 transition-colors hover:text-muted"
      >
        <Info size={13} aria-hidden="true" />
      </button>
    </HoverTip>
  );
}
