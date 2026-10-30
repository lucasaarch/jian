'use client';

import { LoaderCircle } from 'lucide-react';
import type { ButtonHTMLAttributes } from 'react';

export type ActionTone = 'primary' | 'glass' | 'quiet' | 'danger' | 'outline';

const tones: Record<ActionTone, string> = {
  primary: 'bg-accent text-on-accent hover:bg-accent-hover shadow-sm',
  glass: 'glass hover:bg-glass-hover text-ink',
  quiet: 'text-muted hover:bg-glass-hover hover:text-ink',
  danger: 'text-bad hover:bg-bad-soft',
  /** Flat inside a card, where a lifted glass button would stand out of it. */
  outline: 'border border-glass-edge bg-glass-hover text-ink hover:bg-glass-press',
};

/** `small` sits at the end of a settings row. */
const sizes = {
  regular: 'h-9 gap-2 rounded-full px-4 text-sm',
  small: 'h-7 gap-1.5 rounded-md px-2.5 text-xs',
} as const;

/** A button of the kit. Busy disables it and says why, so a slow action cannot fire twice. */
export function Action({
  tone = 'glass',
  size = 'regular',
  busy,
  className = '',
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: ActionTone;
  size?: keyof typeof sizes;
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      {...props}
      disabled={props.disabled || busy}
      className={`inline-flex items-center justify-center font-medium transition-colors disabled:pointer-events-none disabled:opacity-45 ${sizes[size]} ${tones[tone]} ${className}`}
    >
      {busy && (
        <LoaderCircle
          size={size === 'small' ? 13 : 15}
          className="animate-spin"
          aria-hidden="true"
        />
      )}
      {children}
    </button>
  );
}
