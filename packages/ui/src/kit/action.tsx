'use client';

import { LoaderCircle } from 'lucide-react';
import { type ButtonHTMLAttributes, createContext, useContext } from 'react';

export type ActionTone = 'primary' | 'glass' | 'quiet' | 'danger' | 'outline';

const tones: Record<ActionTone, string> = {
  primary: 'bg-accent text-on-accent hover:bg-accent-hover shadow-sm',
  glass: 'glass hover:bg-glass-hover text-ink',
  quiet: 'text-muted hover:bg-glass-hover hover:text-ink',
  danger: 'text-bad hover:bg-bad-soft',
  /** Flat inside a card, where a lifted glass button would stand out of it. */
  outline: 'border border-glass-edge bg-glass-hover text-ink hover:bg-glass-press',
};

/**
 * The same tones afloat over what scrolls under them, on glass of their own so they stay legible.
 * Primary and glass already stand on something.
 */
const afloat: Record<ActionTone, string> = {
  primary: `${tones.primary} shadow-lg`,
  glass: tones.glass,
  quiet: 'glass text-muted hover:bg-glass-hover hover:text-ink',
  danger: 'glass text-bad hover:bg-bad-soft',
  outline: tones.glass,
};

/**
 * An overlay's floating actions, drawn outside the form they act for: the form a submit button
 * must name to go on submitting it, and to keep Enter working in its fields.
 */
export const FloatingActions = createContext<{ form?: string } | null>(null);

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
  const floating = useContext(FloatingActions);
  return (
    <button
      type="button"
      {...(floating?.form && props.type === 'submit' ? { form: floating.form } : {})}
      {...props}
      disabled={props.disabled || busy}
      className={`inline-flex items-center justify-center font-medium whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-45 ${sizes[size]} ${(floating ? afloat : tones)[tone]} ${className}`}
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
