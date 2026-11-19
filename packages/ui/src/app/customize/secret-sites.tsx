'use client';

import { Plus, Trash2 } from 'lucide-react';
import { useId, useRef } from 'react';
import { Action, iconButton, RowInput } from '../../kit';
import { MAX_SITES } from './secret-form';

/**
 * The addresses a Secret is for, one origin per row, each with what the gateway would say of it
 * on its own row. A path or a query is typed freely; only the origin is kept.
 */
export function SecretSites({
  sites,
  problems,
  busy,
  onChange,
}: {
  sites: string[];
  /** Why the gateway would refuse each row, if it would. */
  problems: (string | undefined)[];
  busy: boolean;
  onChange: (sites: string[]) => void;
}) {
  const ids = useId();
  // As the fields: each row keeps its key while what is typed in it changes.
  const made = useRef(0);
  const keys = useRef<number[]>([]);
  while (keys.current.length < sites.length) keys.current.push(made.current++);
  keys.current.length = sites.length;
  const remove = (index: number) => {
    keys.current.splice(index, 1);
    onChange(sites.filter((_, at) => at !== index));
  };

  return (
    <div className="grid gap-2">
      <span id={`${ids}-label`} className="text-[13px] font-medium text-ink">
        Sites
      </span>
      {sites.length > 0 && (
        <ul className="grid gap-2">
          {sites.map((site, index) => {
            const key = keys.current[index];
            const problem = problems[index];
            return (
              <li key={key} className="grid gap-1">
                <div className="flex items-center gap-2">
                  <RowInput
                    labelledBy={`${ids}-label`}
                    {...(problem ? { describedBy: `${ids}-${key}-problem` } : {})}
                    className="w-full min-w-0 flex-1"
                    type="url"
                    value={site}
                    placeholder="https://app.example.com"
                    aria-invalid={Boolean(problem)}
                    autoComplete="off"
                    spellCheck={false}
                    onChange={(event) =>
                      onChange(sites.map((item, at) => (at === index ? event.target.value : item)))
                    }
                  />
                  <button
                    type="button"
                    className={iconButton}
                    aria-label={`Remove ${site.trim() || 'this site'}`}
                    disabled={busy}
                    onClick={() => remove(index)}
                  >
                    <Trash2 size={14} aria-hidden="true" />
                  </button>
                </div>
                {problem && (
                  <small id={`${ids}-${key}-problem`} className="text-xs leading-snug text-bad">
                    {problem}
                  </small>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex items-start justify-between gap-4">
        <small className="min-w-0 text-xs leading-snug text-muted">
          Where it is used, such as the page it signs in to. Only the https origin is kept.
        </small>
        <Action
          tone="outline"
          size="small"
          className="shrink-0"
          disabled={busy || sites.length >= MAX_SITES}
          onClick={() => onChange([...sites, ''])}
        >
          <Plus size={13} />
          Add a site
        </Action>
      </div>
    </div>
  );
}
