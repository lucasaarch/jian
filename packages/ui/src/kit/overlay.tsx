'use client';

import { Dialog } from '@base-ui/react/dialog';
import { X } from 'lucide-react';
import { type ReactNode, useRef } from 'react';

/** On a phone a room or a page fills the screen, clear of the status bar and home indicator. */
const fullScreen =
  'phone:inset-0 phone:size-full phone:max-h-none phone:translate-0 phone:rounded-none phone:border-0 phone:bg-canvas phone:pt-[env(safe-area-inset-top)] phone:pb-[env(safe-area-inset-bottom)]';

const sizes = {
  // A room of pages lays its sidebar and page side by side, each filling the height.
  settings: `flex h-[min(44rem,calc(100dvh-6rem))] w-[min(60rem,calc(100vw-3rem))] overflow-hidden ${fullScreen}`,
  // A form rises from the bottom on a phone, where the thumb is, as tall as it needs.
  // A form scrolls as one block: as a flex row, a long one would be held to the overlay's height
  // and lose its bottom padding under what overflows it.
  form: 'block scroll-inset max-h-[calc(100dvh-6rem)] w-[min(28rem,calc(100vw-3rem))] overflow-y-auto phone:top-auto phone:bottom-0 phone:left-0 phone:w-full phone:max-h-[calc(100dvh-env(safe-area-inset-top)-1rem)] phone:translate-0 phone:rounded-b-none phone:pb-[env(safe-area-inset-bottom)]',
  // A page scrolls inside the pane, so what floats in its corners is placed from the pane's own
  // edges: placed inside what scrolls, it would sit a scrollbar further from the right.
  page: `flex flex-col max-h-[calc(100dvh-6rem)] w-[min(40rem,calc(100vw-3rem))] overflow-hidden ${fullScreen}`,
};

/**
 * A pane of glass over the app, the app blurred behind it: where settings live. Escape, the
 * close button or a click outside it closes it; the app keeps its place underneath. Settings
 * leave out the button, as their layout has its own way back.
 */
export function Overlay({
  open,
  onOpenChange,
  title,
  closeButton = true,
  size = 'settings',
  corner,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Read by assistive technology; a layout inside draws its own heading. */
  title: string;
  closeButton?: boolean;
  /**
   * `settings`, a room of pages; `form`, as wide as one form and as tall as it is; `page`, one
   * page of settings with no pages beside it.
   */
  size?: keyof typeof sizes;
  /**
   * What stays afloat at a `page`'s bottom corner however it is scrolled. The page leaves room
   * after its end, so nothing stays under it.
   */
  corner?: ReactNode;
  children: ReactNode;
}) {
  const page = useRef<HTMLDivElement>(null);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/25 backdrop-blur-[3px] transition-opacity duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <Dialog.Popup
          // A page is read from its top: focus on its first link or its button at the end would
          // open it scrolled down to it, and focus here lets the keys scroll it. A form and a room
          // start on their first control.
          {...(size === 'page' ? { initialFocus: page } : {})}
          className={`glass-strong fixed top-1/2 left-1/2 z-50 ${sizes[size]} -translate-x-1/2 -translate-y-1/2 rounded-[1.375rem] text-ink outline-none transition-[opacity,scale] duration-200 data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:scale-[0.98] data-starting-style:opacity-0`}
        >
          <Dialog.Title className="sr-only">{title}</Dialog.Title>
          {size === 'page' ? (
            <div
              ref={page}
              tabIndex={-1}
              className={`scroll-inset min-h-0 grow overflow-y-auto outline-none ${corner ? 'pb-14' : ''}`}
            >
              {children}
            </div>
          ) : (
            children
          )}
          {corner && (
            <div className="absolute right-3.5 bottom-3.5 z-10 phone:bottom-[max(0.875rem,env(safe-area-inset-bottom))]">
              {corner}
            </div>
          )}
          {closeButton && (
            <Dialog.Close
              aria-label="Close"
              className={`absolute top-3.5 right-3.5 z-10 grid size-8 place-items-center rounded-full text-muted transition-colors hover:bg-glass-hover hover:text-ink phone:top-[calc(env(safe-area-inset-top)+0.875rem)] ${size === 'page' ? 'glass' : ''}`}
            >
              <X size={16} />
            </Dialog.Close>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
