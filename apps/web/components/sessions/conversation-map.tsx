'use client';

import { type RefObject, useEffect, useState } from 'react';

/** One of the owner's messages, as the map marks it: what they said and how the agent began. */
export type MapEntry = { id: string; text: string; reply?: string };

/** Past this many, the marks get closer so the map still fits beside the conversation. */
const ROOMY = 40;

/**
 * A minimap of the conversation: one mark per message the owner sent, beside the column, the
 * one being read drawn longer. Pointing at a mark shows what was said and how the agent began
 * to answer; a click scrolls there. It only appears where the pane has room to spare on both
 * sides of the reading column, so it never crowds the text.
 */
export function ConversationMap({
  scroller,
  entries,
}: {
  scroller: RefObject<HTMLElement | null>;
  entries: MapEntry[];
}) {
  const [active, setActive] = useState<string>();

  useEffect(() => {
    const view = scroller.current;
    if (!view || entries.length < 2) return;
    let frame = 0;

    // The message being read is the last one whose top has passed a third of the view.
    const locate = () => {
      frame = 0;
      const line = view.getBoundingClientRect().top + view.clientHeight / 3;
      let current = entries[0]?.id;

      for (const entry of entries) {
        const element = view.querySelector(`[data-message-id="${CSS.escape(entry.id)}"]`);
        if (element && element.getBoundingClientRect().top <= line) current = entry.id;
      }
      setActive(current);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(locate);
    };

    locate();
    view.addEventListener('scroll', schedule, { passive: true });

    return () => {
      view.removeEventListener('scroll', schedule);
      cancelAnimationFrame(frame);
    };
  }, [scroller, entries]);

  if (entries.length < 2) return null;

  return (
    <nav
      className="conversation-map"
      aria-label="Conversation map"
      data-dense={entries.length > ROOMY || undefined}
    >
      {entries.map((entry) => (
        <button
          key={entry.id}
          type="button"
          className="conversation-map-mark"
          aria-current={entry.id === active ? 'true' : undefined}
          aria-label={entry.text}
          onClick={() =>
            scroller.current
              ?.querySelector(`[data-message-id="${CSS.escape(entry.id)}"]`)
              ?.scrollIntoView({ block: 'start', behavior: 'smooth' })
          }
        >
          <span className="conversation-map-tip" aria-hidden="true">
            <span>{entry.text}</span>
            {entry.reply && <small>{entry.reply}</small>}
          </span>
        </button>
      ))}
    </nav>
  );
}
