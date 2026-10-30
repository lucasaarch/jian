'use client';

import { Plus, Trash2 } from 'lucide-react';
import { Fragment, useId, useRef } from 'react';
import { blankValue, MAX_VALUE_ROWS } from '../../components/integrations/mcp-draft';
import { Action, RowInput } from '../../kit';
import type { McpValue } from '../../lib/api';

/**
 * Name and value pairs — a server's headers, a command's environment — where a value already
 * stored shows as kept rather than as empty, and is kept unless it is typed again.
 */
export function McpValues({
  label,
  hint,
  placeholder,
  list,
  stored,
  busy,
  onChange,
}: {
  label: string;
  hint: string;
  placeholder: string;
  list: McpValue[];
  /** What the gateway holds for the server, to say which names already have a value. */
  stored: McpValue[];
  busy: boolean;
  onChange: (list: McpValue[]) => void;
}) {
  const ids = useId();
  const id = (part: string) => `${ids}-${part}`;
  const update = (index: number, patch: Partial<McpValue>) =>
    onChange(list.map((value, at) => (at === index ? { ...value, ...patch } : value)));
  // A pair has no identity of its own, and its text changes as it is typed: each row gets a key
  // when it is added, and gives it up when it is removed, so the rows after it keep theirs.
  const made = useRef(0);
  const keys = useRef<number[]>([]);
  while (keys.current.length < list.length) keys.current.push(made.current++);
  keys.current.length = list.length;
  const rows = list.map((value, index) => ({ value, index, key: keys.current[index] }));
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
          <span id={id('name')} className="px-0.5 text-xs text-muted">
            Name
          </span>
          <span id={id('value')} className="px-0.5 text-xs text-muted">
            Value
          </span>
          <span />
          {rows.map(({ value, index, key }) => (
            <Fragment key={key}>
              <RowInput
                labelledBy={`${id('label')} ${id('name')}`}
                className="w-full"
                value={value.name}
                placeholder={placeholder}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => update(index, { name: event.target.value })}
              />
              <RowInput
                labelledBy={`${id('label')} ${id('value')}`}
                className="w-full"
                type="password"
                autoComplete="off"
                value={value.value ?? ''}
                placeholder={
                  stored.some((item) => item.name === value.name && !item.fromEnv)
                    ? 'Saved — leave blank to keep'
                    : 'Value'
                }
                onChange={(event) => update(index, { value: event.target.value })}
              />
              <Action
                tone="quiet"
                size="small"
                aria-label={`Remove ${value.name || label}`}
                disabled={busy}
                onClick={() => remove(index)}
              >
                <Trash2 size={13} />
              </Action>
            </Fragment>
          ))}
        </div>
      )}
      <div className="flex items-start justify-between gap-4">
        <small className="text-xs leading-snug text-muted">{hint}</small>
        <Action
          tone="quiet"
          size="small"
          disabled={busy || list.length >= MAX_VALUE_ROWS}
          onClick={() => onChange([...list, blankValue()])}
        >
          <Plus size={13} />
          Add another
        </Action>
      </div>
    </div>
  );
}
