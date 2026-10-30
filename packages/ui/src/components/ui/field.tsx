'use client';

import { cloneElement, type ReactElement, useId } from 'react';

/** The label and the hint are tied to the control itself, whatever control is passed in. */
export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactElement<{ id?: string; 'aria-describedby'?: string }>;
}) {
  const id = useId();

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {cloneElement(children, {
        id,
        'aria-describedby':
          [children.props['aria-describedby'], hint ? `${id}-hint` : undefined]
            .filter(Boolean)
            .join(' ') || undefined,
      })}
      {hint && <small id={`${id}-hint`}>{hint}</small>}
    </div>
  );
}
