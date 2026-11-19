'use client';

import { ContextMenu } from '@base-ui/react/context-menu';
import { ArrowLeft, ArrowRight, Copy, Plus, Trash2 } from 'lucide-react';
import type { DragEvent, KeyboardEvent } from 'react';
import { MenuDivider, MenuEntry, MenuSubmenu, menuPopup } from '../../../../kit';
import { NewSlideEntries } from './add-slide';
import { SlideFrame } from './slide-frame';
import type { SlideOps } from './use-slide-ops';

/** What a drag of a slide carries: its place, counted from 0. Only the rail reads it. */
export const SLIDE_DRAG = 'application/x-jian-slide';

/**
 * A change made from the keyboard, waiting for the rail it ends in. The deck is drawn anew for
 * each version, rail included, so the focus would fall to the page: the new rail takes it back,
 * on the slide in view. Module state, since what holds it is the very rail that goes.
 */
export const keyedChange = { pending: false };

/**
 * One slide of the rail, small and numbered. A click shows it; the menu its right click opens (or
 * the keyboard's menu key) adds a slide after it, copies, moves or deletes it, and it is dragged
 * to another place. Focused, Delete deletes it and Alt with an arrow moves it.
 *
 * The slide is looked at, not used: the button over it is what a click and a key reach. The
 * corners are cut by every box around the frame, each taking the radius of the one outside it
 * (`rounded-[inherit]`), and the white a slide sits on is the frame's own background: no second
 * layer shows past a softened corner. The filter on the box that holds the frame changes no
 * colour; it makes the scaled frame draw as one picture before the corners cut it.
 */
export function SlideThumb({
  slide,
  index,
  count,
  current,
  ops,
  drop,
  onAt,
  onDragOver,
  onDrop,
}: {
  slide: string;
  /** Its place, counted from 0. */
  index: number;
  count: number;
  current: boolean;
  /** The owner's changes to the slides, or none where the deck is only read. */
  ops: SlideOps | undefined;
  /** Where a dragged slide would land against this one, drawn as a line on that side. */
  drop: 'before' | 'after' | undefined;
  onAt: (index: number) => void;
  onDragOver: (index: number, side: 'before' | 'after' | undefined) => void;
  onDrop: (from: number) => void;
}) {
  const number = index + 1;
  const busy = !ops || ops.busy;

  const keyed = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (busy) return;
    if ((event.key === 'Delete' || event.key === 'Backspace') && count > 1) {
      event.preventDefault();
      keyedChange.pending = true;
      ops.remove(index);
      return;
    }
    const by = event.altKey ? { ArrowLeft: -1, ArrowRight: 1 }[event.key] : undefined;
    if (!by) return;
    // Not a step to the next slide, which the deck does with the arrow alone.
    event.preventDefault();
    event.stopPropagation();
    const to = index + by;
    if (to < 0 || to >= count) return;
    keyedChange.pending = true;
    ops.move(index, to);
  };
  const side = (event: DragEvent) => {
    const box = event.currentTarget.getBoundingClientRect();
    return event.clientX < box.left + box.width / 2 ? 'before' : 'after';
  };

  return (
    <ContextMenu.Root disabled={!ops}>
      <ContextMenu.Trigger
        className="relative flex shrink-0 items-start gap-1.5"
        onDragOver={(event: DragEvent<HTMLDivElement>) => {
          if (busy || !event.dataTransfer.types.includes(SLIDE_DRAG)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          onDragOver(index, side(event));
        }}
        onDragLeave={() => onDragOver(index, undefined)}
        onDrop={(event: DragEvent<HTMLDivElement>) => {
          const from = Number(event.dataTransfer.getData(SLIDE_DRAG));
          if (busy || !event.dataTransfer.types.includes(SLIDE_DRAG)) return;
          event.preventDefault();
          if (Number.isInteger(from)) onDrop(from);
        }}
      >
        {drop && (
          <span
            aria-hidden="true"
            className={`absolute inset-y-0 w-0.5 rounded-full bg-accent ${drop === 'before' ? '-left-2' : '-right-2'}`}
          />
        )}
        <span className="pt-0.5 text-[11px] text-muted tabular-nums">{number}</span>
        <div
          className={`relative aspect-video w-24 overflow-hidden rounded-md ring-1 transition-shadow ${current ? 'ring-2 ring-accent' : 'ring-glass-edge'}`}
        >
          <div inert className="absolute inset-0 grid rounded-[inherit] [filter:opacity(1)]">
            <SlideFrame
              title={`Slide ${number}, small`}
              source={slide}
              lazy
              className="size-full"
            />
          </div>
          <button
            type="button"
            aria-label={`Slide ${number}`}
            aria-current={current ? 'true' : undefined}
            aria-keyshortcuts={ops ? 'Delete Alt+ArrowLeft Alt+ArrowRight' : undefined}
            draggable={!busy && count > 1}
            className="absolute inset-0 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-inset"
            onClick={() => onAt(index)}
            onKeyDown={keyed}
            onDragStart={(event) => {
              event.dataTransfer.setData(SLIDE_DRAG, String(index));
              event.dataTransfer.effectAllowed = 'move';
            }}
            onDragEnd={() => onDragOver(index, undefined)}
          />
        </div>
      </ContextMenu.Trigger>
      {ops && (
        <ContextMenu.Portal>
          <ContextMenu.Positioner className="z-50">
            <ContextMenu.Popup className={`${menuPopup} min-w-48`}>
              <MenuSubmenu icon={<Plus size={14} />} label="New slide after">
                <NewSlideEntries onAdd={(what) => ops.add(index, what)} />
              </MenuSubmenu>
              <MenuEntry
                icon={<Copy size={14} />}
                disabled={busy}
                onClick={() => ops.add(index, 'duplicate')}
              >
                Duplicate
              </MenuEntry>
              <MenuEntry
                icon={<ArrowLeft size={14} />}
                disabled={busy || index === 0}
                onClick={() => ops.move(index, index - 1)}
              >
                Move left
              </MenuEntry>
              <MenuEntry
                icon={<ArrowRight size={14} />}
                disabled={busy || index === count - 1}
                onClick={() => ops.move(index, index + 1)}
              >
                Move right
              </MenuEntry>
              <MenuDivider />
              <MenuEntry
                icon={<Trash2 size={14} />}
                danger
                disabled={busy || count === 1}
                onClick={() => ops.remove(index)}
              >
                Delete
              </MenuEntry>
            </ContextMenu.Popup>
          </ContextMenu.Positioner>
        </ContextMenu.Portal>
      )}
    </ContextMenu.Root>
  );
}
