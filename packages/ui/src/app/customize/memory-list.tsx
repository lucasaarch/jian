'use client';

import { Link2 } from 'lucide-react';
import { StatusPill, surfaceCard } from '../../kit';
import type { Memory, Project } from '../../lib/api';

/**
 * The memories as plain rows, newest first: the key, the start of the text, how many it is
 * linked to and the projects it is pinned to. The accessible way through everything the map
 * shows; a row opens the same panel a node does.
 */
export function MemoryList({
  memories,
  projects,
  selected,
  empty,
  onSelect,
}: {
  memories: Memory[];
  projects: Project[];
  selected: string;
  /** What to say when there are none to show. */
  empty: string;
  onSelect: (key: string) => void;
}) {
  const names = new Map(projects.map((project) => [project.id, project.name]));

  return (
    <ul
      aria-label="Memories"
      className={`min-w-0 divide-y divide-glass-edge overflow-hidden ${surfaceCard}`}
    >
      {memories.map((memory) => {
        const links = memory.links?.length ?? 0;
        const pinned = (memory.projectIds ?? []).flatMap((id) => names.get(id) ?? []);

        return (
          <li key={memory.key}>
            <button
              type="button"
              aria-label={`Open ${memory.key}`}
              aria-pressed={memory.key === selected}
              onClick={() => onSelect(memory.key)}
              className={`grid w-full min-w-0 grid-cols-1 gap-1 px-4 py-3 text-left transition-colors hover:bg-glass-press focus-visible:bg-glass-press focus-visible:outline-none ${
                memory.key === selected ? 'bg-glass-press' : ''
              }`}
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 truncate text-[13px] font-medium text-ink">
                  {memory.key}
                </span>
                {links > 0 && (
                  <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted">
                    <Link2 size={12} aria-hidden="true" />
                    {links}
                  </span>
                )}
                <span className="flex min-w-0 flex-1 justify-end gap-1.5">
                  {pinned.slice(0, 2).map((name) => (
                    <StatusPill key={name} tone="good">
                      <span className="max-w-32 truncate">{name}</span>
                    </StatusPill>
                  ))}
                  {pinned.length > 2 && <StatusPill>+{pinned.length - 2}</StatusPill>}
                </span>
              </span>
              <span className="truncate text-xs text-muted">{memory.content}</span>
            </button>
          </li>
        );
      })}
      {memories.length === 0 && <li className="px-4 py-3 text-[13px] text-muted">{empty}</li>}
    </ul>
  );
}
