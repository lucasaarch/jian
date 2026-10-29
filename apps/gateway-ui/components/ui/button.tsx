'use client';

import { LoaderCircle } from 'lucide-react';
import type { ButtonHTMLAttributes } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'quiet' | 'danger';

/** The look of a button, for a link that acts as one as well as for Button itself. */
export const buttonClass = (variant: ButtonVariant = 'primary', className = '') =>
  `button ${variant} ${className}`;

/** Busy both disables the button and shows why, so a slow action cannot be fired twice. */
export function Button({
  children,
  variant = 'primary',
  busy,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  busy?: boolean;
}) {
  return (
    <button
      type="button"
      {...props}
      disabled={props.disabled || busy}
      className={buttonClass(variant, props.className)}
    >
      {busy && <LoaderCircle size={16} className="spin" aria-hidden="true" />}
      {children}
    </button>
  );
}
