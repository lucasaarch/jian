'use client';

import { type ReactNode, useLayoutEffect, useRef } from 'react';

/**
 * The composer, or a channel's agent toolbar, floating over the end of the conversation on a
 * pane of glass, so what scrolls beneath it shows blurred instead of cut off.
 *
 * The conversation needs to know how much of its end is covered, to leave that much room after
 * its last message: the dock and the tray above it (errors, a waiting question, agents at work)
 * are measured as they change and published as `--dock-height` and `--tray-height` on the chat.
 * A reader at the end stays at the end when the composer grows with a long draft or a file.
 */
export function ConversationDock({ children }: { children: ReactNode }) {
  const dock = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const element = dock.current;
    const chat = element?.parentElement;
    if (!element || !chat) return;
    const tray = chat.querySelector<HTMLElement>('.history-tray');
    const view = chat.querySelector<HTMLElement>('.message-history');
    const measure = () => {
      const atEnd = view ? view.scrollHeight - view.scrollTop - view.clientHeight < 80 : false;

      chat.style.setProperty('--dock-height', `${element.offsetHeight}px`);
      chat.style.setProperty('--tray-height', `${tray?.offsetHeight ?? 0}px`);
      if (view && atEnd) view.scrollTop = view.scrollHeight;
    };
    const observer = new ResizeObserver(measure);

    observer.observe(element);
    if (tray) observer.observe(tray);
    measure();

    return () => {
      observer.disconnect();
      chat.style.removeProperty('--dock-height');
      chat.style.removeProperty('--tray-height');
    };
  }, []);

  return (
    <>
      <div className="conversation-glass" aria-hidden="true" />
      <div ref={dock} className="conversation-dock">
        {children}
      </div>
    </>
  );
}
