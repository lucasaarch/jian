'use client';

import type { InputHTMLAttributes, TextareaHTMLAttributes } from 'react';

const field =
  'rounded-lg border border-glass-edge bg-glass-hover text-[13px] text-ink outline-none transition-[border-color,background-color] placeholder:text-muted/70 hover:bg-glass-press focus:border-ink/25 focus:bg-glass-press';

/**
 * A field at the end of a settings row, named by the row: `labelledBy` is the row's title, so
 * the words are said once, beside it, and not again above it.
 */
export function RowInput({
  labelledBy,
  describedBy,
  className = 'w-64',
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { labelledBy: string; describedBy?: string }) {
  return (
    <input
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      {...props}
      className={`${field} h-8 px-2.5 py-0 phone:w-full ${className}`}
    />
  );
}

/** Writing too long for the end of a row, across it, under the row's own title. */
export function RowTextArea({
  labelledBy,
  describedBy,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { labelledBy: string; describedBy?: string }) {
  return (
    <textarea
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      {...props}
      className={`${field} min-h-48 w-full resize-y px-3 py-2.5 leading-relaxed`}
    />
  );
}
