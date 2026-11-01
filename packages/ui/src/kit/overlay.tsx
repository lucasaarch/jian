'use client';

import { Dialog } from '@base-ui/react/dialog';
import { X } from 'lucide-react';
import {
  createContext,
  type ReactNode,
  useContext,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { watchSize } from '../lib/watch-size';
import { FloatingActions } from './action';

/** On a phone a room or a page fills the screen, clear of the status bar and home indicator. */
const fullScreen =
  'phone:inset-0 phone:size-full phone:max-h-none phone:translate-0 phone:rounded-none phone:border-0 phone:bg-canvas phone:pt-[env(safe-area-inset-top)] phone:pb-[env(safe-area-inset-bottom)]';

/**
 * Where what floats in a form or a page stands: the same 1.75rem as the padding of what they hold
 * (`p-7`), so every edge in the pane lines up.
 */
const PANE_EDGE = 'inset-x-7';

const sizes = {
  // A room of pages lays its sidebar and page side by side, each filling the height.
  settings: `flex h-[min(44rem,calc(100dvh-6rem))] w-[min(60rem,calc(100vw-3rem))] overflow-hidden ${fullScreen}`,
  // A form and a page scroll inside the pane, so what floats in its corners is placed from the
  // pane's own edges: placed inside what scrolls, it would sit a scrollbar further from the right.
  // A form rises from the bottom on a phone, where the thumb is, as tall as it needs.
  form: 'flex flex-col max-h-[calc(100dvh-6rem)] w-[min(36rem,calc(100vw-3rem))] overflow-hidden phone:top-auto phone:bottom-0 phone:left-0 phone:w-full phone:max-h-[calc(100dvh-env(safe-area-inset-top)-1rem)] phone:translate-0 phone:rounded-b-none phone:pb-[env(safe-area-inset-bottom)]',
  page: `flex flex-col max-h-[calc(100dvh-6rem)] w-[min(44rem,calc(100vw-3rem))] overflow-hidden ${fullScreen}`,
};

/** Where the overlay around them floats its actions; undefined outside of one. */
const ActionsSlot = createContext<HTMLElement | null | undefined>(undefined);

/**
 * What an overlay's form or page does, afloat at the bottom of the pane however it is scrolled.
 * Written where the form is, as its state is there; a submit button goes on submitting that form.
 * A `flex-1` span between them sends what follows to the right, where they all go otherwise.
 */
export function OverlayActions({ children }: { children: ReactNode }) {
  const slot = useContext(ActionsSlot);
  const marker = useRef<HTMLSpanElement>(null);
  const named = useId();
  const [form, setForm] = useState<string>();
  useLayoutEffect(() => {
    const owner = marker.current?.closest('form');
    if (!owner) return;
    owner.id ||= named;
    setForm(owner.id);
  }, [named]);

  return (
    <>
      <span ref={marker} hidden />
      {slot === undefined ? (
        <div className="flex flex-wrap items-center justify-end gap-2">{children}</div>
      ) : (
        slot &&
        createPortal(
          <FloatingActions.Provider value={form ? { form } : {}}>
            {children}
          </FloatingActions.Provider>,
          slot,
        )
      )}
    </>
  );
}

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
  children: ReactNode;
}) {
  const page = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [slot, setSlot] = useState<HTMLDivElement | null>(null);
  // A scrollbar takes its width from what scrolls, which would leave the content a scrollbar short
  // of what floats over it. The content is let out by exactly that much, under the scrollbar, into
  // its own padding: it keeps its width and lines up, however long it runs.
  useLayoutEffect(() => {
    const scroller = page.current;
    if (!slot || !scroller || !content.current) return;
    const measure = () =>
      scroller.style.setProperty(
        '--overlay-scrollbar',
        `${scroller.offsetWidth - scroller.clientWidth}px`,
      );
    measure();
    return watchSize(measure, scroller, content.current);
  }, [slot]);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/25 backdrop-blur-[3px] transition-opacity duration-200 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <Dialog.Popup
          // A page is read from its top: focus on its first link or its button at the end would
          // open it scrolled down to it, and focus here lets the keys scroll it. A form and a room
          // start on their first control.
          {...(size === 'page' ? { initialFocus: page } : {})}
          className={`group/overlay glass-strong fixed top-1/2 left-1/2 z-50 ${sizes[size]} -translate-x-1/2 -translate-y-1/2 rounded-[1.375rem] text-ink outline-none transition-[opacity,scale] duration-200 data-ending-style:scale-[0.98] data-ending-style:opacity-0 data-starting-style:scale-[0.98] data-starting-style:opacity-0`}
        >
          <Dialog.Title className="sr-only">{title}</Dialog.Title>
          <ActionsSlot.Provider value={slot}>
            {size === 'settings' ? (
              children
            ) : (
              <div
                ref={page}
                tabIndex={-1}
                // Room after the end for the actions afloat, so nothing has to stay under them, and
                // what scrolls fades out before it reaches them, above where that room starts.
                className="scroll-inset min-h-0 grow overflow-x-hidden overflow-y-auto outline-none group-has-[[data-overlay-actions]>*]/overlay:pb-14 group-has-[[data-overlay-actions]>*]/overlay:[mask-image:linear-gradient(to_bottom,black_calc(100%-5.25rem),transparent_calc(100%-3.125rem))]"
              >
                <div ref={content} className="mr-[calc(-1*var(--overlay-scrollbar,0px))]">
                  {children}
                </div>
              </div>
            )}
          </ActionsSlot.Provider>
          {size !== 'settings' && (
            <div
              ref={setSlot}
              data-overlay-actions
              className={`pointer-events-none absolute z-10 flex flex-wrap items-center justify-end gap-2 empty:hidden [&>:not(span)]:pointer-events-auto ${PANE_EDGE} bottom-7 phone:bottom-[max(1.75rem,env(safe-area-inset-bottom))]`}
            />
          )}
          {closeButton && (
            <Dialog.Close
              aria-label="Close"
              className={`absolute z-10 grid size-8 place-items-center rounded-full text-muted transition-colors hover:bg-glass-hover hover:text-ink ${size === 'settings' ? 'top-3.5 right-3.5 phone:top-[calc(env(safe-area-inset-top)+0.875rem)]' : 'glass top-6.5 right-7 phone:top-[calc(env(safe-area-inset-top)+1.625rem)]'}`}
            >
              <X size={16} />
            </Dialog.Close>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
