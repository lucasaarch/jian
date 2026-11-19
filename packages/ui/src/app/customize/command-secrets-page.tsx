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
import type { CommandSecret } from '../../lib/api';
import { date } from '../../lib/format';
import { useAgent } from '../../lib/query/agent';
import { useProfiles } from '../../lib/query/profile';
import { useActions } from '../../lib/workspace';
import { CommandSecretDialog } from './command-secret-dialog';
import { useCommandSecrets } from './command-secrets';

/**
 * Keys this agent's commands may use, such as a transcription service's: each a line with its
 * name, what it is for, when it was added and last used, and who else may use it. Its value is
 * never on screen: it is typed once, and replaced by typing another.
 */
export function CommandSecretsPage() {
  const actions = useActions();
  const profile = useAgent();
  const agents = useProfiles().data ?? [];
  const { secrets, loading, error, add, change, remove } = useCommandSecrets(profile.id, actions);
  // Each dialog keeps what it shows while it fades out, apart from whether it is open.
  const [editing, setEditing] = useState<CommandSecret>();
  const [formOpen, setFormOpen] = useState(false);
  const [removing, setRemoving] = useState<CommandSecret>();
  const [asking, setAsking] = useState(false);

  const open = (secret?: CommandSecret) => {
    setEditing(secret);
    setFormOpen(true);
  };
  const sharedWith = (secret: CommandSecret) =>
    agents
      .filter((agent) => agent.id !== profile.id && secret.profileIds.includes(agent.id))
      .map((agent) => agent.name);

  const note = error ? (
    <span role="alert" className="text-bad">
      {error}
    </span>
  ) : undefined;

  return (
    <>
      <SettingsGroup
        title="Command secrets"
        note={note}
        loading={loading && !error && 'Loading command secrets…'}
      >
        {loading && !error && <SettingsRowsSkeleton count={2} description buttons={2} />}
        {secrets.map((secret) => {
          const others = sharedWith(secret);
          return (
            <SettingsRow
              key={secret.name}
              title={<span className="block truncate font-mono">{secret.name}</span>}
              description={
                <>
                  {secret.description && <span className="block">{secret.description}</span>}
                  <span className="block">
                    Added {date(secret.createdAt)} · Last used{' '}
                    {secret.lastUsedAt ? date(secret.lastUsedAt) : 'never'}
                    {others.length > 0 && ` · Also ${others.join(', ')}`}
                  </span>
                </>
              }
            >
              <Action
                tone="outline"
                size="small"
                aria-label={`Edit ${secret.name}`}
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
                aria-label={`Delete ${secret.name}`}
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
          );
        })}
        {!loading && (
          <SettingsRow
            title={secrets.length ? 'Add a secret' : 'No secrets yet'}
            description={
              secrets.length
                ? undefined
                : `An API key ${profile.name}'s commands can use, without ever seeing it.`
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
      <CommandSecretDialog
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
        title={`Delete ${removing?.name ?? ''}?`}
        phrase={removing?.name ?? ''}
        action="Delete secret"
        busy={actions.busy}
        run={async () => {
          if (removing && (await remove(removing.name))) setAsking(false);
        }}
      >
        {removing && removing.profileIds.length > 1
          ? 'It is gone for every agent that uses it, and their commands can no longer use it. '
          : 'Its commands can no longer use it. '}
        This cannot be undone.
      </ConfirmDialog>
    </>
  );
}
