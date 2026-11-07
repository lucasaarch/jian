'use client';

import { MESSAGES_FIRST_PAGE } from '@jian/contracts';
import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { useStore } from 'zustand';
import { Action } from '../../../kit/action';
import type { Reader } from './reader';
import type { ConversationStore } from './store';

/** How close to the top of the conversation, in px, reading further back begins. */
const EARLIER_WITHIN_PX = 400;

/**
 * Further back in the conversation: whether there is more, the read that brings it near the top,
 * and the reader kept on the line they were reading as earlier pages appear above it.
 */
export function useEarlier(
  store: ConversationStore,
  reader: RefObject<Reader | undefined>,
  scroller: RefObject<HTMLElement | null>,
) {
  const more = useStore(
    store,
    (state) => !state.atBeginning && state.messages.length >= MESSAGES_FIRST_PAGE,
  );
  const earlier = useStore(store, (state) => state.earlier);
  const messages = useStore(store, (state) => state.messages);
  const from = useRef<{ top: number; height: number }>(undefined);

  // Where the reader was just before the page lands, taken as the store changes and before the
  // page is drawn: after it, the scroll has already moved.
  useEffect(
    () =>
      store.subscribe((state, previous) => {
        const view = scroller.current;
        if (previous.earlier !== 'reading' || state.messages[0] === previous.messages[0]) return;
        if (view) from.current = { top: view.scrollTop, height: view.scrollHeight };
      }),
    [store, scroller],
  );
  // Set outright rather than added to: a browser that anchors scrolling has already moved it by
  // some amount.
  // biome-ignore lint/correctness/useExhaustiveDependencies: messages growing is what this answers.
  useLayoutEffect(() => {
    const held = from.current;
    const view = scroller.current;
    if (!held || !view) return;
    from.current = undefined;
    view.scrollTop = held.top + view.scrollHeight - held.height;
  }, [messages, scroller]);

  const read = useCallback(() => void reader.current?.earlier(), [reader]);
  // Before the reader reaches the top, so a long scroll back does not stop at each page.
  const near = useCallback(
    (view: HTMLElement) => {
      if (view.scrollTop < EARLIER_WITHIN_PX && more && earlier === 'idle') read();
    },
    [more, earlier, read],
  );

  return { more, earlier, read, near };
}

/** Above the first message shown: the way further back, and what happened when it was tried. */
export function Earlier({
  earlier,
  onRead,
}: {
  earlier: 'idle' | 'reading' | 'failed';
  onRead: () => void;
}) {
  return (
    <div className="history-earlier">
      {earlier === 'failed' && <p>Earlier messages could not be read.</p>}
      <Action tone="quiet" size="small" busy={earlier === 'reading'} onClick={onRead}>
        Show earlier messages
      </Action>
    </div>
  );
}
