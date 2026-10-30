'use client';

import { Dialog } from '@base-ui/react/dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * A pane of glass over the app, the app blurred behind it: where settings live. Escape, the
 * close button or a click outside it closes it; the app keeps its place underneath.
 */
export function Overlay({
  open,
  onOpenChange,
  title,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Read by assistive technology; a layout inside draws its own heading. */
  title: string;
  children: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/25 backdrop-blur-[3px] transition-opacity duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <Dialog.Popup className="glass-strong fixed top-1/2 left-1/2 z-50 flex h-[min(44rem,calc(100dvh-6rem))] w-[min(60rem,calc(100vw-3rem))] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-[1.375rem] text-ink outline-none transition-[opacity,scale] duration-200 data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:scale-[0.98] data-starting-style:opacity-0">
          <Dialog.Title className="sr-only">{title}</Dialog.Title>
          {children}
          <Dialog.Close
            aria-label="Close"
            className="absolute top-3.5 right-3.5 grid size-8 place-items-center rounded-full text-muted transition-colors hover:bg-glass-hover hover:text-ink"
          >
            <X size={16} />
          </Dialog.Close>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
