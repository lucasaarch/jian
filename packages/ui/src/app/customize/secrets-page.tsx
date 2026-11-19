'use client';

import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import {
  Action,
  ConfirmDialog,
  SettingsGroup,
  SettingsRow,
  SettingsRowSkeleton,
  SettingsRowsSkeleton,
} from '../../kit';
import type { Profile, Secret } from '../../lib/api';
import { date } from '../../lib/format';
import { useAgent } from '../../lib/query/agent';
import { useProfiles } from '../../lib/query/profile';
import { useActions } from '../../lib/workspace';
import { SecretDialog } from './secret-dialog';
import { useSecrets } from './secrets';

/** Where a Secret is used, by host alone: the origin's scheme is always https. */
const hostOf = (site: string) => site.replace(/^https:\/\//, '');

/**
 * Who made it, when it was added and last used, and who else may use it, in one line. An agent
 * that made it is named; one the owner made says nothing of who.
 */
function aboutOf(secret: Secret, profileId: string, agents: Profile[]): string {
  const name = (id: string | null) => agents.find((agent) => agent.id === id)?.name;
  const maker = name(secret.createdByProfileId);
  const others = secret.profileIds.flatMap((id) => {
    const other = id === profileId ? undefined : name(id);
    return other ? [other] : [];
  });
  return [
    maker && `Made by ${maker}`,
    `Added ${date(secret.createdAt)}`,
    `Last used ${secret.lastUsedAt ? date(secret.lastUsedAt) : 'never'}`,
    others.length > 0 && `Shared with ${others.join(', ')}`,
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * The Secrets this agent's commands may use, such as a service's key or a login: each a line with
 * its title, its fields and sites, who made it and who else may use it. A sensitive value is never
 * on screen: it is typed once, and replaced by typing another.
 */
export function SecretsPage() {
  const actions = useActions();
  const profile = useAgent();
  const agents = useProfiles().data ?? [];
  const { secrets, loading, error, add, change, remove } = useSecrets(profile.id, actions);
  // Each dialog keeps what it shows while it fades out, apart from whether it is open.
  const [editing, setEditing] = useState<Secret>();
  const [formOpen, setFormOpen] = useState(false);
  const [removing, setRemoving] = useState<Secret>();
  const [asking, setAsking] = useState(false);

  const open = (secret?: Secret) => {
    setEditing(secret);
    setFormOpen(true);
  };

  const note = error ? (
    <span role="alert" className="text-bad">
      {error}
    </span>
  ) : undefined;

  return (
    <>
      <SettingsGroup title="Secrets" note={note} loading={loading && !error && 'Loading Secrets…'}>
        {loading && !error && <SettingsRowsSkeleton count={2} description buttons={2} />}
        {secrets.map((secret) => (
          <SettingsRow
            key={secret.id}
            title={<span className="block truncate">{secret.title}</span>}
            description={
              <>
                {secret.description && <span className="block">{secret.description}</span>}
                <span className="block truncate">
                  {[
                    secret.fields.map((field) => field.label).join(', '),
                    ...secret.sites.map(hostOf),
                  ].join(' · ')}
                </span>
                <span className="block">{aboutOf(secret, profile.id, agents)}</span>
              </>
            }
          >
            <Action
              tone="outline"
              size="small"
              aria-label={`Edit ${secret.title}`}
              disabled={actions.busy}
              onClick={() => open(secret)}
            >
              <Pencil size={13} />
              Edit
            </Action>
            <Action
              tone="danger"
              size="small"
              className="border border-bad/40"
              aria-label={`Delete ${secret.title}`}
              disabled={actions.busy}
              onClick={() => {
                setRemoving(secret);
                setAsking(true);
              }}
            >
              <Trash2 size={13} />
              Delete
            </Action>
          </SettingsRow>
        ))}
        {!loading && (
          <SettingsRow
            title={secrets.length ? 'Add a Secret' : 'No secrets yet'}
            description={
              secrets.length
                ? undefined
                : `An API key or a login ${profile.name}'s commands can use, without ever seeing what is sensitive.`
            }
          >
            <Action tone="outline" size="small" onClick={() => open()}>
              <Plus size={13} />
              Add
            </Action>
          </SettingsRow>
        )}
        {loading && !error && <SettingsRowSkeleton index={2} />}
      </SettingsGroup>
      <SecretDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        profileId={profile.id}
        {...(editing ? { editing } : {})}
        busy={actions.busy}
        add={add}
        change={change}
      />
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title={`Delete ${removing?.title ?? ''}?`}
        phrase={removing?.title ?? ''}
        action="Delete secret"
        busy={actions.busy}
        run={async () => {
          if (removing && (await remove(removing.id))) setAsking(false);
        }}
      >
        {removing && removing.profileIds.length > 1
          ? 'It is gone for every agent that uses it, with every value it holds. '
          : 'Its commands can no longer use it, and every value it holds is gone. '}
        This cannot be undone.
      </ConfirmDialog>
    </>
  );
}
