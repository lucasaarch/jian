'use client';

import type { MouseEvent, ReactNode } from 'react';
import { Action } from './action';

/**
 * A round glass button that floats over what scrolls under it and fades and rises in while
 * `shown`: the chat's way back to the latest message, a page's way back to the top. The caller
 * places the wrapper (`className`); its motion lives in `.float-button` (surfaces-shell.css).
 * Kept on the page while hidden so it can fade out, and meanwhile out of reach of the keyboard
 * and the screen reader.
 */
export function FloatButton({
  shown,
  label,
  onClick,
  className = '',
  children,
}: {
  shown: boolean;
  label: string;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`float-button ${className}`} data-shown={shown || undefined}>
      <Action
        tone="glass"
        size="icon"
        aria-label={label}
        title={label}
        aria-hidden={shown ? undefined : true}
        inert={!shown}
        onClick={onClick}
      >
        {children}
      </Action>
    </div>
  );
}
