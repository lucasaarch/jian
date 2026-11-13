'use client';

import { Brain, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { MEMORY_CONTENT_LIMIT, type memoryActions } from '../../components/memories/memory-actions';
import { Action, MultiSelectField, StatusPill, surfaceCard, TextArea } from '../../kit';
import type { Memory, Project } from '../../lib/api';
import { MemoryLinks } from './memory-links';

/** The panel's frame, shared by a memory and by the empty panel, so the two line up. */
const frame = `grid min-w-0 content-start gap-5 p-4 ${surfaceCard}`;

/** What stands in the panel while no memory is open. */
export function MemoryDetailEmpty({ count }: { count: number }) {
  return (
    <aside
      aria-label="Memory"
      className={`${frame} place-content-center justify-items-center text-center`}
    >
      <Brain size={22} className="text-muted" aria-hidden="true" />
      <p className="max-w-56 text-[13px] leading-snug text-muted">
        {count > 0
          ? 'Pick a memory to read it, rewrite it, link it to others or pin it to a project.'
          : 'What the agent records in conversations shows up here.'}
      </p>
    </aside>
  );
}

type Props = {
  memory: Memory;
  all: Memory[];
  projects: Project[];
  busy: boolean;
  actions: ReturnType<typeof memoryActions>;
  /** Opens a linked memory in this one's place. */
  follow: (key: string) => void;
  /** Asks to confirm, then forgets it. */
  onForget: (memory: Memory) => void;
};

/**
 * One memory beside the map or the list: its text, rewritten by the owner; what it is recalled
 * with; and the projects it is pinned to. Links and pins change at once, apart from the
 * text's own save. Remount it per memory and version so the text starts from what is stored.
 */
export function MemoryDetail({ memory, all, projects, busy, actions, follow, onForget }: Props) {
  const [content, setContent] = useState(memory.content);
  const trimmed = content.trim();
  const dirty = Boolean(trimmed) && trimmed !== memory.content;

  return (
    <aside aria-label="Memory" className={frame}>
      <header className="grid gap-1">
        <h3 className="flex min-w-0 items-center gap-2 text-base font-semibold tracking-tight">
          <span className="truncate">{memory.key}</span>
          <StatusPill>v{memory.version}</StatusPill>
        </h3>
        <p className="text-xs text-muted">
          {memory.sourceSessionId ? 'Written in a conversation.' : 'Edited by you.'}
        </p>
      </header>
      <TextArea
        label="Memory"
        hint={`${content.length} of ${MEMORY_CONTENT_LIMIT} characters`}
        rows={5}
        maxLength={MEMORY_CONTENT_LIMIT}
        value={content}
        onChange={(event) => setContent(event.target.value)}
      />
      {dirty && (
        <div className="flex justify-end gap-2">
          <Action tone="quiet" size="small" onClick={() => setContent(memory.content)}>
            Discard
          </Action>
          <Action
            tone="primary"
            size="small"
            busy={busy}
            onClick={() => void actions.save(memory, trimmed)}
          >
            Save
          </Action>
        </div>
      )}
      <MemoryLinks
        memory={memory}
        all={all}
        busy={busy}
        link={(key) => void actions.link(memory, key)}
        unlink={(key) => void actions.unlink(memory, key)}
        follow={follow}
      />
      {projects.length > 0 && (
        <MultiSelectField
          label="Projects"
          hint="In a chat on one of these, the agent reads this memory first."
          placeholder="Not pinned to a project"
          values={memory.projectIds ?? []}
          options={projects.map((project) => ({ value: project.id, label: project.name }))}
          onValuesChange={(ids) => void actions.setProjects(memory, ids)}
        />
      )}
      <div>
        <Action
          tone="danger"
          size="small"
          className="bg-bad/10"
          disabled={busy}
          onClick={() => onForget(memory)}
        >
          <Trash2 size={13} aria-hidden="true" />
          Forget
        </Action>
      </div>
    </aside>
  );
}
