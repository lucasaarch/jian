'use client';

import { type InputHTMLAttributes, type TextareaHTMLAttributes, useId } from 'react';

/** The kit's field: what text fields, selects and pickers are drawn as, alike in a form. */
export const control =
  'w-full rounded-xl border border-glass-edge bg-glass-hover px-3.5 text-sm text-ink outline-none transition-[border-color,background-color,box-shadow] placeholder:text-muted/70 hover:bg-glass-press focus:border-ink/25 focus:bg-glass-press focus:shadow-[0_0_0_3px] focus:shadow-ink/8';

/**
 * A field with no ground of its own, for a search at the top of a glass surface: the panel's
 * base rule gives every input a border, a fill and room, which this takes away again.
 */
export const bareInput =
  'h-full min-w-0 flex-1 rounded-none border-0 bg-transparent p-0 text-ink shadow-none outline-none placeholder:text-muted/70 focus:border-0 focus:bg-transparent focus:shadow-none';

/** A labelled field of the kit; the hint is tied to the control, for whatever reads it out. */
export function Labelled({
  label,
  hint,
  id,
  children,
}: {
  label: string;
  hint?: string;
  id: string;
  children: React.ReactNode;
}) {
  return (
    // Never wider than the form it is in, whatever its control holds.
    <div className="grid min-w-0 grid-cols-1 gap-1.5">
      <label htmlFor={id} className="text-[13px] font-medium text-ink">
        {label}
      </label>
      {children}
      {hint && (
        <small id={`${id}-hint`} className="text-xs leading-snug text-muted">
          {hint}
        </small>
      )}
    </div>
  );
}

export function TextField({
  label,
  hint,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  const id = useId();
  return (
    <Labelled label={label} hint={hint} id={id}>
      <input
        id={id}
        aria-describedby={hint ? `${id}-hint` : undefined}
        {...props}
        className={`${control} h-10`}
      />
    </Labelled>
  );
}

export function TextArea({
  label,
  hint,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string; hint?: string }) {
  const id = useId();
  return (
    <Labelled label={label} hint={hint} id={id}>
      <textarea
        id={id}
        aria-describedby={hint ? `${id}-hint` : undefined}
        {...props}
        className={`${control} min-h-28 resize-y py-2.5 leading-relaxed`}
      />
    </Labelled>
  );
}
