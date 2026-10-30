'use client';

import { Link2, X } from 'lucide-react';
import { linkCandidates, MEMORY_LINK_LIMIT } from '../../components/memories/memory-actions';
import { SelectButton } from '../../kit';
import type { Memory } from '../../lib/api';

/**
 * The memories one is recalled with. A link changes the moment it is added or removed, apart
 * from the text's own save; a linked one opens in its place, so a topic can be followed by hand.
 */
export function MemoryLinks({
  memory,
  all,
  busy,
  link,
  unlink,
  follow,
}: {
  memory: Memory;
  all: Memory[];
  busy: boolean;
  link: (key: string) => void;
  unlink: (key: string) => void;
  follow: (key: string) => void;
}) {
  const links = memory.links ?? [];
  const candidates = linkCandidates(memory, all).map((item) => ({
    value: item.key,
    label: item.key,
    detail: item.content.slice(0, 80),
  }));

  return (
    <div className="grid justify-items-start gap-1.5">
      <span className="text-[13px] font-medium text-ink">Recalled with</span>
      {links.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label={`Recalled with ${memory.key}`}>
          {links.map((key) => (
            <li
              key={key}
              className="inline-flex h-7 items-center rounded-md border border-glass-edge bg-glass-hover text-xs text-ink"
            >
              <button
                type="button"
                aria-label={`Open ${key}`}
                onClick={() => follow(key)}
                className="h-full pl-2.5 pr-1.5 underline-offset-2 hover:underline"
              >
                {key}
              </button>
              <button
                type="button"
                aria-label={`Unlink ${key}`}
                disabled={busy}
                onClick={() => unlink(key)}
                className="grid h-full place-items-center pr-2 pl-0.5 text-muted transition-colors hover:text-bad disabled:opacity-45"
              >
                <X size={12} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {links.length >= MEMORY_LINK_LIMIT ? (
        <small className="text-xs leading-snug text-muted">
          A memory holds up to {MEMORY_LINK_LIMIT} links.
        </small>
      ) : (
        candidates.length > 0 && (
          <SelectButton
            label="Link another memory"
            options={candidates}
            disabled={busy}
            onValueChange={link}
          >
            <Link2 size={13} aria-hidden="true" />
            Link another memory
          </SelectButton>
        )
      )}
      <small className="text-xs leading-snug text-muted">
        When this memory is relevant, these come with it.
      </small>
    </div>
  );
}
