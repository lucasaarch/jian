'use client';

import { useState } from 'react';
import { MEMORY_CONTENT_LIMIT, type memoryActions } from '../../components/memories/memory-actions';
import { Action, Overlay, TextArea } from '../../kit';
import type { Memory } from '../../lib/api';
import { MemoryLinks } from './memory-links';

type FormProps = {
  memory: Memory | undefined;
  all: Memory[];
  busy: boolean;
  actions: ReturnType<typeof memoryActions>;
  /** Opens a linked memory in this one's place. */
  follow: (key: string) => void;
  /** Asks to confirm, then forgets it. */
  onForget: (memory: Memory) => void;
};

/**
 * One memory, rewritten by the owner, and the memories it is recalled with. `round` changes on
 * every opening and every link followed, so each starts from the memory it shows.
 */
export function MemoryDialog({
  open,
  onOpenChange,
  round,
  memory,
  ...form
}: { open: boolean; onOpenChange: (open: boolean) => void; round: number } & FormProps) {
  return (
    <Overlay open={open} onOpenChange={onOpenChange} title={memory?.key ?? 'Memory'} size="form">
      {memory && (
        <MemoryForm key={round} memory={memory} {...form} onCancel={() => onOpenChange(false)} />
      )}
    </Overlay>
  );
}

function MemoryForm({
  memory,
  all,
  busy,
  actions,
  follow,
  onForget,
  onCancel,
}: Omit<FormProps, 'memory'> & { memory: Memory; onCancel: () => void }) {
  const [content, setContent] = useState(memory.content);
  const trimmed = content.trim();

  return (
    <form
      className="grid w-full gap-5 p-7"
      onSubmit={async (event) => {
        event.preventDefault();
        if (await actions.save(memory, trimmed)) onCancel();
      }}
    >
      <header className="grid gap-1.5 pr-6">
        <h2 className="flex items-center gap-2.5 text-lg font-semibold tracking-tight">
          <span className="truncate">{memory.key}</span>
        </h2>
        <p className="text-sm text-muted">
          {memory.sourceSessionId ? 'Written in a conversation.' : 'Edited by you.'}
        </p>
      </header>
      <TextArea
        label="Memory"
        hint={`${content.length} of ${MEMORY_CONTENT_LIMIT} characters`}
        required
        rows={6}
        maxLength={MEMORY_CONTENT_LIMIT}
        value={content}
        onChange={(event) => setContent(event.target.value)}
      />
      <MemoryLinks
        memory={memory}
        all={all}
        busy={busy}
        link={(key) => void actions.link(memory, key)}
        unlink={(key) => void actions.unlink(memory, key)}
        follow={follow}
      />
      <div className="flex items-center gap-2">
        <Action
          tone="danger"
          className="bg-bad/10"
          disabled={busy}
          onClick={() => onForget(memory)}
        >
          Forget
        </Action>
        <span className="flex-1" />
        <Action tone="quiet" onClick={onCancel}>
          Cancel
        </Action>
        <Action
          tone="primary"
          type="submit"
          busy={busy}
          disabled={!trimmed || trimmed === memory.content}
        >
          Save
        </Action>
      </div>
    </form>
  );
}
