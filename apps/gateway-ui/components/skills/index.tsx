'use client';

import { BookOpen, Eye, Pencil, Plus, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import type { SectionProps } from '../props';
import { Badge, Button, Confirm, Empty, ProviderLogo, ResourceRow, SectionHeading } from '../ui';
import { BuiltinSkills } from './built-in';
import { SkillCatalog } from './catalog';
import { SkillImport } from './import';
import { McpForm } from './mcp-form';
import { McpRow } from './mcp-row';
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

export function Capabilities({
  kind,
  profile,
  api,
  mutate,
  busy,
}: Omit<SectionProps, 'data'> & { kind: 'skills' | 'mcpServers' }) {
  const [editing, setEditing] = useState<number | 'new'>();
  const [removing, setRemoving] = useState<number>();
  const [failed, setFailed] = useState(false);
  // The skill whose instructions are open for reading.
  const [open, setOpen] = useState<string>();
  const isSkill = kind === 'skills';
  const viewing = isSkill ? profile.skills.find((skill) => skill.name === open) : undefined;
  const items = profile[kind];
  const skill = typeof editing === 'number' && isSkill ? profile.skills[editing] : undefined;
  const mcp = typeof editing === 'number' && !isSkill ? profile.mcpServers[editing] : undefined;

  const save = async (next: unknown) => {
    const updated =
      editing === 'new'
        ? [...items, next]
        : items.map((item, index) => (index === editing ? next : item));

    const ok = await mutate(
      () => api.updateProfile(profile.id, { expectedVersion: profile.version, [kind]: updated }),
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
        title={isSkill ? 'Skills' : 'MCP servers'}
        description={
          isSkill
            ? 'Specialised instructions, loaded by the agent when it needs them.'
            : 'The agent discovers the tools each server offers and loads what it needs.'
        }
        action={
          <Button
            onClick={() => {
              setFailed(false);
              setEditing('new');
            }}
            disabled={items.length >= (isSkill ? 20 : 10)}
          >
            <Plus size={16} />
            {isSkill ? 'New skill' : 'Connect a server'}
          </Button>
        }
      />
      {isSkill && <BuiltinSkills profile={profile} api={api} mutate={mutate} busy={busy} />}
      {isSkill ? (
        <section className="row-group" aria-labelledby="skills-installed">
          <h2 id="skills-installed">Installed</h2>
          <p>
            Written here, imported, or written by the agent itself. Each profile keeps its own copy.
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
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={`Edit ${item.name}`}
                          onClick={() => {
                            setFailed(false);
                            setEditing(index);
                          }}
                        >
                          <Pencil size={16} />
                        </button>
                        <button
                          type="button"
                          className="icon-button"
                          aria-label={`Remove ${item.name}`}
                          onClick={() => setRemoving(index)}
                        >
                          <Trash2 size={16} />
                        </button>
                      </>
                    }
                  />
                );
              })}
            </div>
          ) : (
            <p className="rounded-md bg-surface px-5 py-4 text-sm">
              No skill installed. Pick one from the catalogs below, or import from your repository.
            </p>
          )}
        </section>
      ) : profile.mcpServers.length ? (
        <div className="resource-list">
          {profile.mcpServers.map((item, index) => (
            <McpRow
              key={item.name}
              server={item}
              profile={profile}
              api={api}
              onEdit={() => {
                setFailed(false);
                setEditing(index);
              }}
              onRemove={() => setRemoving(index)}
              saving={busy}
              onToggleTool={(tool) => {
                const off = item.disabledTools ?? [];

                void mutate(
                  () =>
                    api.updateProfile(profile.id, {
                      expectedVersion: profile.version,
                      mcpServers: profile.mcpServers.map((server) =>
                        server.name === item.name
                          ? {
                              ...server,
                              disabledTools: off.includes(tool)
                                ? off.filter((name) => name !== tool)
                                : [...off, tool],
                            }
                          : server,
                      ),
                    }),
                  off.includes(tool) ? `${tool} switched on.` : `${tool} switched off.`,
                );
              }}
            />
          ))}
        </div>
      ) : (
        <Empty title="Connect a tool">
          Give the address of an MCP server. The tools come from it, and the agent loads one before
          it can call it.
        </Empty>
      )}
      {viewing && (
        <SkillView
          name={viewing.name}
          description={viewing.description}
          instructions={viewing.instructions}
          close={() => setOpen(undefined)}
        />
      )}
      {isSkill && <SkillCatalog profile={profile} api={api} mutate={mutate} busy={busy} />}
      {editing !== undefined &&
        (isSkill ? (
          <SkillForm
            skill={skill}
            busy={busy}
            failed={failed}
            onSave={(next) => void save(next)}
            onClose={() => setEditing(undefined)}
          />
        ) : (
          <McpForm
            server={mcp}
            busy={busy}
            error={failed ? 'Could not save. Check the fields, or refresh the profile.' : ''}
            onSave={(next) => void save(next)}
            onClose={() => setEditing(undefined)}
          />
        ))}
      {removing !== undefined && (
        <Confirm
          title={isSkill ? 'Remove this skill?' : 'Disconnect this server?'}
          description="This capability stops being available on the next runs."
          busy={busy}
          close={() => setRemoving(undefined)}
          confirm={async () => {
            if (
              await mutate(
                () =>
                  api.updateProfile(profile.id, {
                    expectedVersion: profile.version,
                    [kind]: items.filter((_, index) => index !== removing),
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
