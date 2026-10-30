'use client';

import { BookOpen, Eye, Pencil, Plus, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import type { Skill } from '../../lib/api';
import { useAgent } from '../../lib/query/agent';
import type { SectionActions } from '../props';
import {
  Badge,
  Button,
  Confirm,
  IconButton,
  ProviderLogo,
  ResourceRow,
  SectionHeading,
} from '../ui';
import { BuiltinSkills } from './built-in';
import { SkillImport } from './import';
import { SkillForm } from './skill-form';
import { SkillView } from './skill-view';

/** Where a skill came from: a vendor's own catalog by its logo, any other repository by path. */
function originOf(url?: string): { label: string; path?: string; logo?: ReactNode } {
  if (!url) return { label: 'Written here' };
  const path = new URL(url).pathname.split('/').slice(1, 3).join('/');

  if (path.startsWith('anthropics/'))
    return { label: 'Anthropic', path, logo: <ProviderLogo kind="anthropic" size={22} /> };
  if (path.startsWith('openai/'))
    return { label: 'OpenAI', path, logo: <ProviderLogo kind="openai" size={22} /> };

  return { label: 'Imported', path };
}

/** This agent's own skills: the built-in ones it carries, and those written or imported here. */
export function Skills({ api, mutate, busy }: SectionActions) {
  const profile = useAgent();
  const [editing, setEditing] = useState<number | 'new'>();
  const [removing, setRemoving] = useState<number>();
  const [failed, setFailed] = useState(false);
  // The skill whose instructions are open for reading.
  const [open, setOpen] = useState<string>();
  const viewing = profile.skills.find((skill) => skill.name === open);
  const items = profile.skills;
  const skill = typeof editing === 'number' ? profile.skills[editing] : undefined;

  const save = async (next: Skill) => {
    const updated =
      editing === 'new'
        ? [...items, next]
        : items.map((item, index) => (index === editing ? next : item));

    const ok = await mutate(
      () => api.updateProfile(profile.id, { expectedVersion: profile.version, skills: updated }),
      'Saved.',
    );

    setFailed(!ok);

    if (ok) {
      setEditing(undefined);
    }
  };

  return (
    <>
      <SectionHeading
        title="Skills"
        description="Specialised instructions, loaded by the agent when it needs them."
        action={
          <Button
            onClick={() => {
              setFailed(false);
              setEditing('new');
            }}
            disabled={items.length >= 20}
          >
            <Plus size={16} />
            New skill
          </Button>
        }
      />
      <BuiltinSkills profile={profile} api={api} mutate={mutate} busy={busy} />
      <section className="row-group" aria-labelledby="skills-installed">
        <h2 id="skills-installed">Installed</h2>
        <p>
          Written here, imported, or written by the agent itself. Each agent keeps its own copy.
        </p>
        <SkillImport profile={profile} api={api} mutate={mutate} busy={busy} />
        {profile.skills.length ? (
          <div className="resource-list">
            {profile.skills.map((item, index) => {
              const from =
                item.writtenBy === 'agent'
                  ? { label: `Written by ${profile.name}` }
                  : originOf(item.origin?.url);

              return (
                <ResourceRow
                  key={item.name}
                  id={`skill-${item.name}`}
                  icon={from.logo ?? <BookOpen size={20} strokeWidth={1.6} />}
                  name={item.name}
                  badges={<Badge dot={false}>{from.label}</Badge>}
                  description={item.description}
                  facts={from.path ? [`From ${from.path}`] : []}
                  actions={
                    <>
                      <Button variant="quiet" onClick={() => setOpen(item.name)}>
                        <Eye size={16} />
                        View
                      </Button>
                      <IconButton
                        aria-label={`Edit ${item.name}`}
                        onClick={() => {
                          setFailed(false);
                          setEditing(index);
                        }}
                      >
                        <Pencil size={16} />
                      </IconButton>
                      <IconButton
                        aria-label={`Remove ${item.name}`}
                        onClick={() => setRemoving(index)}
                      >
                        <Trash2 size={16} />
                      </IconButton>
                    </>
                  }
                />
              );
            })}
          </div>
        ) : (
          <p className="rounded-md bg-surface px-5 py-4 text-sm">
            No skill installed. Write one, or import one from a repository.
          </p>
        )}
      </section>
      {viewing && (
        <SkillView
          name={viewing.name}
          description={viewing.description}
          instructions={viewing.instructions}
          close={() => setOpen(undefined)}
        />
      )}
      {editing !== undefined && (
        <SkillForm
          skill={skill}
          busy={busy}
          failed={failed}
          onSave={(next) => void save(next)}
          onClose={() => setEditing(undefined)}
        />
      )}
      {removing !== undefined && (
        <Confirm
          title="Remove this skill?"
          description="This capability stops being available on the next runs."
          busy={busy}
          close={() => setRemoving(undefined)}
          confirm={async () => {
            if (
              await mutate(
                () =>
                  api.updateProfile(profile.id, {
                    expectedVersion: profile.version,
                    skills: items.filter((_, index) => index !== removing),
                  }),
                'Removed.',
              )
            ) {
              setRemoving(undefined);
            }
          }}
        />
      )}
    </>
  );
}
