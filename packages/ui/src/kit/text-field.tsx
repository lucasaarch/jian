'use client';

import { type InputHTMLAttributes, type TextareaHTMLAttributes, useId } from 'react';

const control =
  'w-full rounded-xl border border-glass-edge bg-glass-hover px-3.5 text-sm text-ink outline-none transition-[border-color,background-color,box-shadow] placeholder:text-muted/70 hover:bg-glass-press focus:border-ink/25 focus:bg-glass-press focus:shadow-[0_0_0_3px] focus:shadow-ink/8';

/** A labelled field of the kit; the hint is tied to the control, for whatever reads it out. */
function Labelled({
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
    <div className="grid gap-1.5">
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
