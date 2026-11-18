'use client';

import { useId, useState } from 'react';
import {
  BackLink,
  ConfirmDialog,
  PageBody,
  Segmented,
  SettingsGroup,
  SettingsRowsSkeleton,
  SkeletonRegion,
} from '../../kit';
import { pluginsPath } from '../../lib/navigation';
import { useNoInspector } from '../../lib/stores/screen';
import { useProfileId } from '../../lib/workspace';
import { useRouter } from '../../platform/navigation';
import { useSkills } from './plugin-skills';
import { SkillEditForm, SkillOverview, SkillSource } from './skill-body';
import { SkillDetails } from './skill-details';
import { SkillActions, SkillEditActions, SkillHeader } from './skill-header';
import { SkillUpdates } from './skill-updates';

type Tab = 'overview' | 'document';

const TABS: { value: Tab; label: string }[] = [
  { value: 'overview', label: 'Overview' },
  { value: 'document', label: 'SKILL.md' },
];

/**
 * One skill, on a page of its own under Plugins, in the conversation's place: what it is for
 * and what the agents are told, as they read it or as the document it is kept as, beside what
 * is known about it. The switch offers it to every agent or to none. One of the library's is
 * edited here, in the overview's place, deleted, and copied again from GitHub when it came from
 * there; a built-in one is Jian's to write, and only read. `name` is the address's, so a skill
 * that is not there, or no longer, is said so with the way back.
 */
export function SkillPage({ name }: { name: string }) {
  useNoInspector();
  const { api, busy, library, items, flip, loading, error } = useSkills();
  const profileId = useProfileId();
  const router = useRouter();
  const form = useId();
  const [tab, setTab] = useState<Tab>('overview');
  const [editing, setEditing] = useState(false);
  const [asking, setAsking] = useState(false);
  const item = items.find((candidate) => candidate.name === name);
  const held = item?.held;
  const origin = held?.origin;
  const plugins = profileId ? pluginsPath(profileId, 'skills') : '/';

  return (
    <div className="flex h-full min-h-0">
      <PageBody wide {...(item ? { labelledBy: 'skill-title' } : { label: 'Skill' })}>
        <div className="grid grid-cols-1 gap-3">
          <BackLink onClick={() => router.push(plugins)}>Plugins</BackLink>
          {item && (
            <SkillHeader item={item}>
              {editing ? (
                <SkillEditActions form={form} busy={busy} onCancel={() => setEditing(false)} />
              ) : (
                <SkillActions
                  item={item}
                  busy={busy}
                  onSwitch={(on) => void flip(item.name, on)}
                  onEdit={() => setEditing(true)}
                  onDelete={() => setAsking(true)}
                />
              )}
            </SkillHeader>
          )}
        </div>
        {item ? (
          <div className="@container grid grid-cols-1 gap-5">
            {!editing && (
              <div className="border-b border-glass-edge pb-2">
                <Segmented flat label="Show" value={tab} options={TABS} onChange={setTab} />
              </div>
            )}
            <div className="grid grid-cols-[minmax(0,1fr)_15rem] items-start gap-x-12 gap-y-8 @max-[44rem]:grid-cols-1">
              {editing && held ? (
                <SkillEditForm
                  id={form}
                  skill={held}
                  onSave={(next) =>
                    void library.update(held.name, next).then((ok) => {
                      if (ok) setEditing(false);
                    })
                  }
                />
              ) : tab === 'overview' ? (
                <SkillOverview item={item} />
              ) : (
                <SkillSource item={item} />
              )}
              <SkillDetails
                item={item}
                updates={
                  held &&
                  origin && (
                    <SkillUpdates
                      skill={held}
                      importedAt={origin.importedAt}
                      api={api}
                      busy={busy}
                      update={() => library.updateFromSource(held.name)}
                    />
                  )
                }
              />
            </div>
          </div>
        ) : loading ? (
          <SkeletonRegion label="Loading skill…">
            <SettingsGroup>
              <SettingsRowsSkeleton count={4} />
            </SettingsGroup>
          </SkeletonRegion>
        ) : error ? (
          <p role="alert" className="text-sm text-muted">
            {error}
          </p>
        ) : (
          // Deleted from here a moment ago, it is on its way out with the question still up.
          !asking && (
            <p className="text-sm text-muted">
              No skill named <span className="text-ink">{name}</span>.
            </p>
          )
        )}
      </PageBody>
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title={`Delete ${name}?`}
        phrase={name}
        action="Delete skill"
        busy={busy}
        run={() =>
          void library.remove(name).then((ok) => {
            // Its page is gone with it: back to the list, in this page's place in the history.
            if (ok) router.replace(plugins);
          })
        }
      >
        Every agent stops using it on its next runs. This cannot be undone.
      </ConfirmDialog>
    </div>
  );
}
