'use client';

import { useState } from 'react';
import {
  forgetNote,
  matchingMemories,
  memoryActions,
} from '../../components/memories/memory-actions';
import {
  ConfirmDialog,
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
import { ago, until } from '../../lib/format';
import { useAgent, useMemories, useProjects } from '../../lib/query/agent';
import { useActions } from '../../lib/workspace';
import { type PluginItem, PluginList, PluginSection } from '../plugins/plugin-list';
import { MemoryIcon, MemoryPage } from './memory-page';

const TITLE = 'Memories';
const DESCRIPTION =
  'What the agent keeps across its conversations. Flash memories delete themselves when they expire.';

/** The memories while they are read: a few lines of text, as the list is. */
export function MemoriesWaiting() {
  return (
    <SkeletonRegion label="Loading memories…" className="grid grid-cols-1 gap-4">
      <PageHeading title={TITLE} description={DESCRIPTION} />
      <SettingsGroup>
        <SettingsRowsSkeleton count={4} />
      </SettingsGroup>
    </SkeletonRegion>
  );
}

type Tab = 'all' | 'permanent' | 'flash';

const TABS: { value: Tab; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'permanent', label: 'Permanent' },
  { value: 'flash', label: 'Flash' },
];

/** `ago` as a row says it: "Updated 5m ago", or the day once it is weeks old. */
function updated(value: string) {
  const since = ago(value);
  if (since === 'now') return 'Updated just now';
  return /^\d+[mhdw]$/.test(since) ? `Updated ${since} ago` : `Updated ${since}`;
}

/**
 * A memory as a row: its key, the start of its text, then when it ends or was last written,
 * how many it is recalled with and the projects it is pinned to.
 */
function memoryRow(memory: Memory, names: ReadonlyMap<string, string>): PluginItem {
  const links = memory.links?.length ?? 0;
  const pinned = (memory.projectIds ?? []).flatMap((id) => names.get(id) ?? []);

  return {
    id: memory.key,
    icon: <MemoryIcon memory={memory} size={16} />,
    name: memory.key,
    verified: false,
    description: memory.content,
    meta: [
      memory.expiresAt ? `Expires in ${until(memory.expiresAt)}` : updated(memory.updatedAt),
      ...(links ? [`${links} ${links === 1 ? 'link' : 'links'}`] : []),
      ...pinned,
    ].join(' · '),
  };
}

/**
 * What the agent kept across its conversations, as Plugins lists skills: a search and the tabs
 * are the only ways to narrow it, and a row opens the memory's page in the list's place, with
 * the way back. Permanent memories stay until forgotten; flash ones, which the agent keeps for
 * work in flight, delete themselves when they expire. The agent writes its memories; the owner
 * reads, corrects, connects and removes them, so there is nothing here to add one.
 */
export function MemoriesPage() {
  const actions = useActions();
  const profile = useAgent();
  const memories = useMemories();
  const projects = useProjects();
  const act = memoryActions(actions, profile.id);
  const [tab, setTab] = useState<Tab>('all');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState('');
  const [forgetting, setForgetting] = useState<Memory>();
  const [asking, setAsking] = useState(false);
  const names = new Map(projects.map((project) => [project.id, project.name]));
  const found = matchingMemories(memories, query, names);
  const permanent = tab === 'flash' ? [] : found.filter((memory) => !memory.expiresAt);
  const flash = tab === 'permanent' ? [] : found.filter((memory) => memory.expiresAt);
  const section = (title: string, items: Memory[]) =>
    items.length > 0 && (
      <PluginSection title={title}>
        <PluginList
          label={title}
          items={items.map((memory) => memoryRow(memory, names))}
          onOpen={setOpen}
        />
      </PluginSection>
    );

  const forget = (
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
        setOpen('');
      }}
    >
      {forgetting ? forgetNote(forgetting) : ''}
    </ConfirmDialog>
  );

  if (open) {
    return (
      <>
        <MemoryPage
          key={open}
          name={open}
          memory={memories.find((item) => item.key === open)}
          all={memories}
          projects={projects}
          busy={actions.busy}
          actions={act}
          onBack={() => setOpen('')}
          follow={setOpen}
          onForget={(item) => {
            setForgetting(item);
            setAsking(true);
          }}
        />
        {forget}
      </>
    );
  }

  if (memories.length === 0) {
    return (
      <div className="grid grid-cols-1 gap-4">
        <PageHeading title={TITLE} description={DESCRIPTION} />
        <SettingsGroup>
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
      <PageHeading title={TITLE} description={DESCRIPTION} />
      <PageToolbar>
        <SearchField
          label="Search memories"
          className="min-w-44 flex-1"
          value={query}
          onValueChange={setQuery}
          onKeyDown={(event) => {
            const first = [...permanent, ...flash][0];
            if (event.key === 'Enter' && first) setOpen(first.key);
          }}
        />
        <Segmented label="Show" value={tab} options={TABS} onChange={setTab} />
      </PageToolbar>
      {section('Permanent', permanent)}
      {section('Flash', flash)}
      {permanent.length + flash.length === 0 && (
        <p className="text-sm text-muted">
          {query.trim()
            ? 'No memory matches.'
            : tab === 'flash'
              ? 'No flash memories right now.'
              : 'No permanent memories yet.'}
        </p>
      )}
    </div>
  );
}
