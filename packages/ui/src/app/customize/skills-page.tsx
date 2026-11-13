'use client';

import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useBuiltinSkills, useBuiltinSwitches } from '../../components/skills/built-in-skills';
import {
  filterSkills,
  type SkillFilter,
  type SkillItem,
  skillFilters,
  skillItems,
} from '../../components/skills/skill-items';
import { SKILL_LIMIT, type SkillEditing, useSkillList } from '../../components/skills/skill-list';
import {
  Action,
  ConfirmDialog,
  FilterSelect,
  PageHeading,
  PageToolbar,
  SearchField,
  Skeleton,
  SkeletonRegion,
  surfaceCard,
} from '../../kit';
import { useActions } from '../../lib/workspace';
import { SkillCard } from './skill-card';
import { SkillDialog } from './skill-dialog';
import { SkillImportDialog } from './skill-import-dialog';
import { SkillReading } from './skill-reading';

/** Cards as wide as 16rem and no narrower, so a phone gets one column and a wide page four. */
const grid = 'grid grid-cols-[repeat(auto-fill,minmax(min(100%,16rem),1fr))] gap-3';

const CardWaiting = () => (
  <div className={`flex flex-col gap-2 p-4 ${surfaceCard}`}>
    <div className="flex h-7 items-center">
      <Skeleton className="h-3.5 w-28" />
    </div>
    <Skeleton className="h-3 w-full" />
    <Skeleton className="h-3 w-2/3" />
    <Skeleton className="mt-2 h-5 w-16 rounded-full" />
  </div>
);

/** The skills while the agent is read: the toolbar's place, and cards to stand for the list. */
export function SkillsWaiting() {
  return (
    <SkeletonRegion label="Loading skills…" className="grid grid-cols-1 gap-4">
      <PageHeading title="Skills" />
      <Skeleton className="h-8 w-full rounded-lg" />
      <div className={grid}>
        {Array.from({ length: 6 }, (_, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: identical placeholders, never reordered.
          <CardWaiting key={index} />
        ))}
      </div>
    </SkeletonRegion>
  );
}

/**
 * The agent's skills as cards, its own and those the gateway ships, searched and filtered by
 * where they came from. Opening one reads it, rendered, in place of the cards; the agent's own
 * are edited in a form, and removing one asks for its name first. A built-in skill is switched
 * on and off.
 */
export function SkillsPage() {
  const { api, mutate, busy } = useActions();
  const { profile, skills, save, remove, importFrom } = useSkillList({ api, mutate });
  const builtIn = useBuiltinSkills(profile, api);
  const { enabled, flip } = useBuiltinSwitches(profile, { api, mutate });
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<SkillFilter>('all');
  // By key, not the item: a switch or a save redraws the card the reading is showing.
  const [reading, setReading] = useState<string>();
  // What the form edits stays set while it closes, so it fades out as it was.
  const [editing, setEditing] = useState<SkillEditing>('new');
  const [formOpen, setFormOpen] = useState(false);
  const [round, setRound] = useState(0);
  const [importing, setImporting] = useState(false);
  // By name: once the list is saved without it, its place belongs to the next skill.
  const [removing, setRemoving] = useState('');
  const [asking, setAsking] = useState(false);
  const full = skills.length >= SKILL_LIMIT;
  const configured = editing === 'new' ? undefined : skills[editing];
  const items = skillItems(skills, builtIn.skills, profile.name, enabled);
  const shown = filterSkills(items, query, filter);
  const open = items.find((item) => item.key === reading);

  const edit = (target: SkillEditing) => {
    setEditing(target);
    setRound((count) => count + 1);
    setFormOpen(true);
  };
  const controls = {
    onEdit: (item: SkillItem) => item.index !== undefined && edit(item.index),
    onRemove: (item: SkillItem) => {
      setRemoving(item.name);
      setAsking(true);
    },
    onSwitch: (item: SkillItem, on: boolean) => void flip(item.name, on),
  };

  return (
    <>
      {open ? (
        <SkillReading
          item={open}
          onBack={() => setReading(undefined)}
          onEdit={controls.onEdit}
          onSwitch={controls.onSwitch}
        />
      ) : (
        <div className="grid grid-cols-1 gap-4">
          <PageHeading
            title="Skills"
            actions={
              <>
                <Action
                  tone="outline"
                  size="small"
                  className="h-8"
                  onClick={() => setImporting(true)}
                >
                  <Plus size={13} />
                  Import
                </Action>
                <Action
                  tone="outline"
                  size="small"
                  className="h-8"
                  disabled={full}
                  title={full ? `An agent keeps up to ${SKILL_LIMIT}.` : undefined}
                  onClick={() => edit('new')}
                >
                  <Plus size={13} />
                  Create
                </Action>
              </>
            }
          />
          <PageToolbar>
            <SearchField
              label="Search skills"
              value={query}
              onValueChange={setQuery}
              className="min-w-48 flex-1"
            />
            <FilterSelect
              label="Show skills"
              value={filter}
              options={skillFilters}
              onValueChange={(next) => setFilter(next as SkillFilter)}
            />
          </PageToolbar>
          {builtIn.error && (
            <p role="alert" className="text-xs text-bad">
              {builtIn.error}
            </p>
          )}
          <div className={grid}>
            {shown.map((item) => (
              <SkillCard
                key={item.key}
                item={item}
                onOpen={(next) => setReading(next.key)}
                {...controls}
              />
            ))}
            {builtIn.loading &&
              !builtIn.error &&
              (filter === 'all' || filter === 'built-in') &&
              Array.from({ length: 3 }, (_, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: identical placeholders, never reordered.
                <CardWaiting key={index} />
              ))}
          </div>
          {!builtIn.loading && shown.length === 0 && (
            <p className="text-sm text-muted">{items.length ? 'No skill matches.' : 'None yet.'}</p>
          )}
        </div>
      )}
      <SkillDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        round={round}
        skill={configured}
        source={configured && items.find((item) => item.index === editing)?.source}
        busy={busy}
        onSave={(next) =>
          void save(next, editing).then((ok) => {
            if (ok) setFormOpen(false);
          })
        }
        {...(configured
          ? {
              onRemove: () => {
                setRemoving(configured.name);
                setAsking(true);
              },
            }
          : {})}
      />
      <SkillImportDialog
        open={importing}
        onOpenChange={setImporting}
        busy={busy}
        importFrom={importFrom}
      />
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title={`Remove ${removing}?`}
        phrase={removing}
        action="Remove skill"
        busy={busy}
        run={() => {
          const index = skills.findIndex((skill) => skill.name === removing);
          if (index < 0) return;
          void remove(index).then((ok) => {
            if (!ok) return;
            setAsking(false);
            setFormOpen(false);
            setReading(undefined);
          });
        }}
      >
        The agent stops using it on its next runs. This cannot be undone.
      </ConfirmDialog>
    </>
  );
}
