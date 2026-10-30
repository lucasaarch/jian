'use client';

import { useState } from 'react';
import {
  forgetNote,
  matchingMemories,
  memoryActions,
} from '../../components/memories/memory-actions';
import {
  Action,
  ConfirmDialog,
  SettingsGroup,
  SettingsRow,
  SettingsRowsSkeleton,
  SkeletonRegion,
} from '../../kit';
import type { Memory } from '../../lib/api';
import { useAgent, useMemories } from '../../lib/query/agent';
import { useActions } from '../../lib/workspace';
import { MemoryDialog } from './memory-dialog';
import { ListSearch, ListSearchWaiting } from './skill-search';

/** The memories while they are read: a few lines of text, each with Configure, and the search. */
export function MemoriesWaiting() {
  return (
    <SkeletonRegion label="Loading memories…" className="grid grid-cols-1">
      <SettingsGroup title="Kept by the agent" note={<ListSearchWaiting />}>
        <SettingsRowsSkeleton count={4} />
      </SettingsGroup>
    </SkeletonRegion>
  );
}

/**
 * What the agent kept across its conversations, a line each — its text, cut to the line — with
 * Configure to rewrite it, link it to others or forget it. The agent writes its memories; the
 * owner reads, corrects and removes them, so there is nothing here to add one.
 */
export function MemoriesPage() {
  const actions = useActions();
  const profile = useAgent();
  const memories = useMemories();
  const act = memoryActions(actions, profile.id);
  const [query, setQuery] = useState('');
  // By key, kept while the dialog fades out; a followed link opens another in its place.
  const [key, setKey] = useState('');
  const [open, setOpen] = useState(false);
  const [round, setRound] = useState(0);
  const [forgetting, setForgetting] = useState<Memory>();
  const [asking, setAsking] = useState(false);
  const found = matchingMemories(memories, query);

  const configure = (next: string) => {
    setKey(next);
    setRound((count) => count + 1);
    setOpen(true);
  };

  return (
    <>
      <SettingsGroup
        title="Kept by the agent"
        note={
          memories.length > 0 && (
            <ListSearch label="Search memories" value={query} onChange={setQuery} />
          )
        }
      >
        {found.map((memory) => (
          <SettingsRow
            key={memory.key}
            title={<span className="block truncate">{memory.content}</span>}
          >
            <Action
              tone="outline"
              size="small"
              aria-label={`Configure ${memory.key}`}
              onClick={() => configure(memory.key)}
            >
              Configure
            </Action>
          </SettingsRow>
        ))}
        {found.length === 0 &&
          (memories.length ? (
            <SettingsRow title="No memory matches." />
          ) : (
            <SettingsRow
              title="Nothing kept yet"
              description="What the agent records in conversations shows up here."
            />
          ))}
      </SettingsGroup>
      <MemoryDialog
        open={open}
        onOpenChange={setOpen}
        round={round}
        memory={memories.find((memory) => memory.key === key)}
        all={memories}
        busy={actions.busy}
        actions={act}
        follow={configure}
        onForget={(memory) => {
          setForgetting(memory);
          setAsking(true);
        }}
      />
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title={`Forget ${forgetting?.key ?? ''}?`}
        phrase="forget"
        action="Forget memory"
        busy={actions.busy}
        run={async () => {
          if (!forgetting || !(await act.forget(forgetting))) return;
          setAsking(false);
          setOpen(false);
        }}
      >
        {forgetting ? forgetNote(forgetting) : ''}
      </ConfirmDialog>
    </>
  );
}
