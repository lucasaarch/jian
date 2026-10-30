'use client';

import { LoaderCircle } from 'lucide-react';
import type { ButtonHTMLAttributes } from 'react';

export type ActionTone = 'primary' | 'glass' | 'quiet' | 'danger';

const tones: Record<ActionTone, string> = {
  primary: 'bg-accent text-on-accent hover:bg-accent-hover shadow-sm',
  glass: 'glass hover:bg-glass-hover text-ink',
  quiet: 'text-muted hover:bg-glass-hover hover:text-ink',
  danger: 'text-bad hover:bg-bad-soft',
};

/** A button of the kit. Busy disables it and says why, so a slow action cannot fire twice. */
export function Action({
  tone = 'glass',
  busy,
  className = '',
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { tone?: ActionTone; busy?: boolean }) {
  return (
    <button
      type="button"
      {...props}
      disabled={props.disabled || busy}
      className={`inline-flex h-9 items-center justify-center gap-2 rounded-full px-4 text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-45 ${tones[tone]} ${className}`}
    >
      {busy && <LoaderCircle size={15} className="animate-spin" aria-hidden="true" />}
      {children}
    </button>
  );
}
