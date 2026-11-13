'use client';

import { List, Network } from 'lucide-react';
import { useMemo, useState } from 'react';
import { layoutGraph } from '../../components/memories/graph-layout';
import {
  forgetNote,
  matchingMemories,
  memoryActions,
} from '../../components/memories/memory-actions';
import {
  ConfirmDialog,
  FilterSelect,
  PageHeading,
  PageToolbar,
  SearchField,
  Segmented,
  SettingsGroup,
  SettingsRow,
  SettingsRowsSkeleton,
  SkeletonRegion,
} from '../../kit';
import type { Memory } from '../../lib/api';
import { useAgent, useMemories, useProjects } from '../../lib/query/agent';
import { useActions } from '../../lib/workspace';
import { MemoryDetail, MemoryDetailEmpty } from './memory-detail';
import { MemoryList } from './memory-list';
import { MemoryMap } from './memory-map';

/** The memories while they are read: a few lines of text, as the list is. */
export function MemoriesWaiting() {
  return (
    <SkeletonRegion label="Loading memories…" className="grid grid-cols-1 gap-4">
      <PageHeading title="Memories" />
      <SettingsGroup title="Kept by the agent">
        <SettingsRowsSkeleton count={4} />
      </SettingsGroup>
    </SkeletonRegion>
  );
}

const ALL_PROJECTS = '';

/**
 * What the agent kept across its conversations, as a map — a node for each memory, a line for
 * each link — or as a list, with the open one beside it to rewrite, link, pin to a project or
 * forget. The agent writes its memories; the owner reads, corrects, connects and removes them,
 * so there is nothing here to add one.
 */
export function MemoriesPage() {
  const actions = useActions();
  const profile = useAgent();
  const memories = useMemories();
  const projects = useProjects();
  const act = memoryActions(actions, profile.id);
  const [view, setView] = useState<'map' | 'list'>('map');
  const [query, setQuery] = useState('');
  const [projectId, setProjectId] = useState(ALL_PROJECTS);
  const [key, setKey] = useState('');
  const [forgetting, setForgetting] = useState<Memory>();
  const [asking, setAsking] = useState(false);
  const found = matchingMemories(memories, query, projectId);
  const memory = memories.find((item) => item.key === key);
  // Laid out again only when the memories or their links change, never on a keystroke.
  const shape = memories.map((item) => `${item.key}>${(item.links ?? []).join(',')}`).join('|');
  // biome-ignore lint/correctness/useExhaustiveDependencies: `shape` is what the layout reads
  const graph = useMemo(() => layoutGraph(memories), [shape]);
  const narrowed = Boolean(query.trim() || projectId);
  const lit = narrowed ? new Set(found.map((item) => item.key)) : null;
  const tinted = new Set(
    projectId
      ? memories.filter((item) => item.projectIds?.includes(projectId)).map((item) => item.key)
      : [],
  );

  /** A shift-click on a node links the open memory to it, or unlinks it when it already is. */
  const pick = (next: string, link = false) => {
    if (link && memory && next !== memory.key) {
      void (memory.links?.includes(next) ? act.unlink(memory, next) : act.link(memory, next));
      return;
    }
    setKey(next);
  };

  if (memories.length === 0) {
    return (
      <div className="grid grid-cols-1 gap-4">
        <PageHeading title="Memories" />
        <SettingsGroup title="Kept by the agent">
          <SettingsRow
            title="Nothing kept yet"
            description="What the agent records in conversations shows up here."
          />
        </SettingsGroup>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4">
      <PageHeading title="Memories" />
      <PageToolbar>
        <Segmented
          label="View"
          value={view}
          onChange={setView}
          options={[
            { value: 'map', label: 'Map', icon: <Network size={13} aria-hidden="true" /> },
            { value: 'list', label: 'List', icon: <List size={13} aria-hidden="true" /> },
          ]}
        />
        <SearchField
          label="Search memories"
          className="min-w-44 flex-1"
          value={query}
          onValueChange={setQuery}
          onKeyDown={(event) => {
            const first = found[0];
            if (event.key === 'Enter' && first) setKey(first.key);
          }}
        />
        {projects.length > 0 && (
          <FilterSelect
            label="Project"
            value={projectId}
            onValueChange={setProjectId}
            options={[
              { value: ALL_PROJECTS, label: 'All projects' },
              ...projects.map((project) => ({ value: project.id, label: project.name })),
            ]}
          />
        )}
      </PageToolbar>
      <div className="grid grid-cols-1 items-stretch gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
        {view === 'map' ? (
          <MemoryMap graph={graph} selected={key} lit={lit} tinted={tinted} onSelect={pick} />
        ) : (
          <MemoryList
            memories={found}
            projects={projects}
            selected={key}
            empty="No memory matches."
            onSelect={setKey}
          />
        )}
        {memory ? (
          <MemoryDetail
            key={`${memory.key}:${memory.version}`}
            memory={memory}
            all={memories}
            projects={projects}
            busy={actions.busy}
            actions={act}
            follow={setKey}
            onForget={(item) => {
              setForgetting(item);
              setAsking(true);
            }}
          />
        ) : (
          <MemoryDetailEmpty count={memories.length} />
        )}
      </div>
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
          setKey('');
        }}
      >
        {forgetting ? forgetNote(forgetting) : ''}
      </ConfirmDialog>
    </div>
  );
}
