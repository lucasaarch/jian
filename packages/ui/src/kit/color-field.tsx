'use client';

import { useEffect, useId, useState } from 'react';
import { bareInput, control, Labelled } from './text-field';

const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** What the system's picker takes: six digits, from three, or from eight with the alpha dropped. */
const picked = (value: string) =>
  /^#[0-9a-f]{3,4}$/i.test(value)
    ? `#${[...value.slice(1, 4)].map((digit) => digit + digit).join('')}`
    : value.slice(0, 7);

/**
 * A colour: a swatch that opens the system's picker, and its #hex to type. What is typed counts
 * once it is a colour; until then the field keeps it as it stands and the colour stays.
 */
export function ColorField({
  label,
  value,
  onValueChange,
}: {
  label: string;
  /** A #hex of three, four, six or eight digits. */
  value: string;
  onValueChange: (value: string) => void;
}) {
  const id = useId();
  const [typed, setTyped] = useState(value);

  useEffect(() => setTyped(value), [value]);

  return (
    <Labelled label={label} id={id}>
      <div
        className={`${control} flex h-10 items-center gap-2.5 pl-2 focus-within:border-ink/25 focus-within:bg-glass-press`}
      >
        <span
          className="relative size-6 shrink-0 overflow-hidden rounded-md border border-glass-edge"
          style={{ background: HEX.test(value) ? value : undefined }}
        >
          <input
            type="color"
            aria-label={`Pick ${label}`}
            value={picked(value)}
            onChange={(event) => onValueChange(event.target.value)}
            className="absolute inset-0 size-full cursor-pointer border-0 p-0 opacity-0"
          />
        </span>
        <input
          id={id}
          value={typed}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => {
            const next = event.target.value.trim();
            setTyped(event.target.value);
            if (HEX.test(next)) onValueChange(next);
          }}
          onBlur={() => setTyped(value)}
          className={`${bareInput} font-mono text-[13px]`}
        />
      </div>
    </Labelled>
  );
}
