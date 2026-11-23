'use client';

import { Plus, Trash2 } from 'lucide-react';
import { Fragment, useId, useRef } from 'react';
import { Action, RowInput } from '../../kit';

export type Pair = { name: string; value: string };

/** At most this many, as the gateway takes. */
const MAX_PAIRS = 20;

/**
 * A webhook's query parameters or headers: name and value rows, added and removed. Values are
 * shown as typed, since most hold `{version}`; a secret among them is never read back.
 */
export function PairsField({
  label,
  hint,
  placeholder,
  list,
  onChange,
}: {
  label: string;
  hint: string;
  placeholder: string;
  list: Pair[];
  onChange: (list: Pair[]) => void;
}) {
  const ids = useId();
  const id = (part: string) => `${ids}-${part}`;
  const update = (index: number, patch: Partial<Pair>) =>
    onChange(list.map((pair, at) => (at === index ? { ...pair, ...patch } : pair)));
  // A pair has no identity of its own: each row gets a key when it is added and gives it up when
  // it is removed, so the rows after it keep theirs, and their focus, as they are typed.
  const made = useRef(0);
  const keys = useRef<number[]>([]);
  while (keys.current.length < list.length) keys.current.push(made.current++);
  keys.current.length = list.length;
  const remove = (index: number) => {
    keys.current.splice(index, 1);
    onChange(list.filter((_, at) => at !== index));
  };

  return (
    <div className="grid gap-1.5">
      <span id={id('label')} className="text-[13px] font-medium text-ink">
        {label}
      </span>
      {list.length > 0 && (
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-2">
          <span id={id('name')} className="text-xs text-muted">
            Name
          </span>
          <span id={id('value')} className="text-xs text-muted">
            Value
          </span>
          <span />
          {list.map((pair, index) => (
            <Fragment key={keys.current[index]}>
              <RowInput
                labelledBy={`${id('label')} ${id('name')}`}
                className="w-full"
                value={pair.name}
                placeholder={placeholder}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => update(index, { name: event.target.value })}
              />
              <RowInput
                labelledBy={`${id('label')} ${id('value')}`}
                className="w-full"
                value={pair.value}
                placeholder="{version}"
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => update(index, { value: event.target.value })}
              />
              <Action
                tone="quiet"
                size="small"
                aria-label={`Remove ${pair.name || label}`}
                onClick={() => remove(index)}
              >
                <Trash2 size={13} />
              </Action>
            </Fragment>
          ))}
        </div>
      )}
      <div className="flex items-start justify-between gap-4">
        <small className="min-w-0 text-xs leading-snug text-muted">{hint}</small>
        <Action
          tone="outline"
          size="small"
          className="shrink-0"
          disabled={list.length >= MAX_PAIRS}
          onClick={() => onChange([...list, { name: '', value: '' }])}
        >
          <Plus size={13} />
          Add
        </Action>
      </div>
    </div>
  );
}
