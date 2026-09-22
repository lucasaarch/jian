'use client';

import { BookOpen, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { McpServer } from '../../lib/api';
import type { SectionProps } from '../props';
import { Button, Confirm, Empty, Field, Modal, SectionHeading } from '../ui';
import { BuiltinSkills } from './built-in';
import { SkillCatalog } from './catalog';
import { SkillImport } from './import';
import { McpRow } from './mcp-row';

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
  const isSkill = kind === 'skills';
  const items = profile[kind];
  const skill = typeof editing === 'number' && isSkill ? profile.skills[editing] : undefined;
  const mcp = typeof editing === 'number' && !isSkill ? profile.mcpServers[editing] : undefined;

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
      {isSkill && <SkillImport profile={profile} api={api} mutate={mutate} busy={busy} />}
      {isSkill && <BuiltinSkills profile={profile} api={api} mutate={mutate} busy={busy} />}
      {isSkill && <h2 className="mb-4 text-2xl">Importadas</h2>}
      {items.length ? (
        <div className="resource-list">
          {items.map((item, index) =>
            isSkill ? (
              <article className="resource-row items-start" key={item.name}>
                <div className="resource-icon">
                  <BookOpen size={20} />
                </div>
                <div className="grow">
                  <h3>{item.name}</h3>
                  <p>{'description' in item ? item.description : item.url}</p>
                  {profile.skills[index]?.origin && (
                    <div className="tag-list">
                      <a href={profile.skills[index].origin.url} target="_blank" rel="noreferrer">
                        Importada de {new URL(profile.skills[index].origin.url).pathname.slice(1)}
                      </a>
                    </div>
                  )}
                </div>
                <div className="row-actions">
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
                </div>
              </article>
            ) : (
              <McpRow
                key={item.name}
                server={profile.mcpServers[index] as McpServer}
                profile={profile}
                api={api}
                onEdit={() => {
                  setFailed(false);
                  setEditing(index);
                }}
                onRemove={() => setRemoving(index)}
              />
            ),
          )}
        </div>
      ) : isSkill ? (
        <p className="rounded-md bg-surface px-5 py-4 text-sm">
          No skill installed. Pick one from the catalog below, or import from your repository.
        </p>
      ) : (
        <Empty title="Connect a tool">
          Give the address of an MCP server. The tools come from it, and the agent loads one before
          it can call it.
        </Empty>
      )}
      {isSkill && <SkillCatalog profile={profile} api={api} mutate={mutate} busy={busy} />}
      {editing !== undefined && (
        <Modal
          title={isSkill ? 'Configurar skill' : 'Configurar servidor MCP'}
          close={() => setEditing(undefined)}
        >
          <form
            method="post"
            action="/ui/"
            onSubmit={async (event) => {
              event.preventDefault();

              const form = new FormData(event.currentTarget);
              const name = String(form.get('name'));

              const next = isSkill
                ? {
                    name,
                    description: String(form.get('description')),
                    instructions: String(form.get('instructions')),
                  }
                : {
                    name,
                    url: String(form.get('url')),
                    ...(form.get('token') ? { bearerToken: String(form.get('token')) } : {}),
                    ...(form.get('env') ? { bearerTokenEnv: String(form.get('env')) } : {}),
                  };

              const updated =
                editing === 'new'
                  ? [...items, next]
                  : items.map((item, index) => (index === editing ? next : item));

              const ok = await mutate(
                () =>
                  api.updateProfile(profile.id, {
                    expectedVersion: profile.version,
                    [kind]: updated,
                  }),
                'Saved.',
              );

              setFailed(!ok);

              if (ok) {
                setEditing(undefined);
              }
            }}
          >
            <Field
              label="Name"
              hint={
                isSkill
                  ? 'Lowercase letters, digits, hyphen and underscore.'
                  : 'Lowercase letters, digits and underscore.'
              }
            >
              <input
                name="name"
                required
                pattern={isSkill ? '[a-z0-9_-]{1,64}' : '[a-z0-9_]{1,30}'}
                defaultValue={skill?.name ?? mcp?.name ?? ''}
              />
            </Field>
            {isSkill ? (
              <>
                <Field
                  label="Description"
                  hint="This is how the agent decides when to use the skill."
                >
                  <input
                    name="description"
                    required
                    maxLength={300}
                    defaultValue={skill?.description ?? ''}
                  />
                </Field>
                <Field label="Instructions">
                  <textarea
                    name="instructions"
                    required
                    rows={9}
                    maxLength={12000}
                    defaultValue={skill?.instructions ?? ''}
                  />
                </Field>
              </>
            ) : (
              <>
                <Field label="HTTP endpoint">
                  <input
                    name="url"
                    type="url"
                    required
                    defaultValue={mcp?.url ?? ''}
                    placeholder="https://mcp.example.com/mcp"
                  />
                </Field>
                <Field
                  label="Server token"
                  hint={
                    editing === 'new'
                      ? 'Encrypted on the gateway and never shown again.'
                      : 'Leave it blank to keep the current token.'
                  }
                >
                  <input name="token" type="password" autoComplete="off" maxLength={16000} />
                </Field>
                <Field
                  label="Environment variable (alternative)"
                  hint="Used only when no token is given above."
                >
                  <input
                    name="env"
                    pattern="JIAN_MCP_[A-Z0-9_]+"
                    defaultValue={mcp?.bearerTokenEnv ?? ''}
                    placeholder="JIAN_MCP_SERVICE"
                  />
                </Field>
              </>
            )}
            {failed && (
              <p role="alert" className="form-error">
                Could not save. Check the fields, or refresh the profile.
              </p>
            )}
            <footer>
              <Button variant="secondary" onClick={() => setEditing(undefined)}>
                Cancel
              </Button>
              <Button type="submit" busy={busy}>
                Save {isSkill ? 'skill' : 'server'}
              </Button>
            </footer>
          </form>
        </Modal>
      )}
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
