'use client';

import { useQueryClient } from '@tanstack/react-query';
import { IdCard, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import {
  Action,
  AgentFace,
  Overlay,
  SettingsGroup,
  SettingsLayout,
  TextArea,
  TextField,
} from '../kit';
import type { Profile } from '../lib/api';
import { panelApi } from '../lib/query/client';
import { queries, useProfiles } from '../lib/query/profile';
import { useRouter } from '../platform/navigation';

type Page = 'identity' | 'delete';

/** One agent's settings, opened from its gear in the status bar. */
export function AgentSettings({
  profileId,
  onOpenChange,
}: {
  /** The agent to show; undefined closes the overlay. */
  profileId: string | undefined;
  onOpenChange: (open: boolean) => void;
}) {
  const profile = useProfiles().data?.find((item) => item.id === profileId);
  const [page, setPage] = useState<Page>('identity');

  return (
    <Overlay
      open={Boolean(profile)}
      onOpenChange={onOpenChange}
      title={`${profile?.name ?? 'Agent'} settings`}
    >
      {profile && (
        <SettingsLayout
          heading={
            <span className="flex items-center gap-2.5">
              <AgentFace name={profile.name} avatar={profile.avatar} size={1.75} />
              <span className="truncate">{profile.name}</span>
            </span>
          }
          pages={[
            { id: 'identity', label: 'Identity', icon: <IdCard size={16} />, group: 'Agent' },
            { id: 'delete', label: 'Delete', icon: <Trash2 size={16} />, group: 'Agent' },
          ]}
          current={page}
          onSelect={(id) => setPage(id as Page)}
        >
          {page === 'identity' ? (
            <Identity key={profile.id} profile={profile} />
          ) : (
            <Delete profile={profile} done={() => onOpenChange(false)} />
          )}
        </SettingsLayout>
      )}
    </Overlay>
  );
}

function Identity({ profile }: { profile: Profile }) {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ ok: boolean; text: string }>();

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setSaid(undefined);
    try {
      const saved = await panelApi().updateProfile(profile.id, {
        expectedVersion: profile.version,
        name: String(form.get('name') ?? ''),
        summary: String(form.get('summary') ?? ''),
        instructions: String(form.get('instructions') ?? ''),
      });
      client.setQueryData(queries.profiles().queryKey, (profiles = []) =>
        profiles.map((item) => (item.id === saved.id ? saved : item)),
      );
      setSaid({ ok: true, text: 'Saved.' });
    } catch (failure) {
      setSaid({ ok: false, text: failure instanceof Error ? failure.message : 'Not saved.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={save}>
      <SettingsGroup
        title="Who it is"
        description="How it is named and described, in the app and to the people it talks with."
      >
        <TextField
          label="Name"
          name="name"
          defaultValue={profile.name}
          required
          maxLength={100}
          autoComplete="off"
        />
        <TextField
          label="Summary"
          name="summary"
          defaultValue={profile.summary}
          placeholder="One line on what it does"
          autoComplete="off"
        />
      </SettingsGroup>
      <SettingsGroup
        title="Instructions"
        description="What it is for and how it works; it reads them before every turn."
      >
        <TextArea
          label="Instructions"
          name="instructions"
          defaultValue={profile.instructions}
          required
          maxLength={8000}
          rows={10}
        />
      </SettingsGroup>
      <div className="flex items-center justify-end gap-3">
        {said && (
          <span role="status" className={`text-sm ${said.ok ? 'text-muted' : 'text-bad'}`}>
            {said.text}
          </span>
        )}
        <Action tone="primary" type="submit" busy={busy}>
          Save
        </Action>
      </div>
    </form>
  );
}

function Delete({ profile, done }: { profile: Profile; done: () => void }) {
  const client = useQueryClient();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const remove = async () => {
    setBusy(true);
    setError('');
    try {
      await panelApi().deleteProfile(profile.id);
      client.setQueryData(queries.profiles().queryKey, (profiles = []) =>
        profiles.filter((item) => item.id !== profile.id),
      );
      done();
      // The chats screen opens another agent, or offers to create one.
      router.replace('/');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The agent could not be deleted.');
      setBusy(false);
    }
  };

  return (
    <SettingsGroup
      title={`Delete ${profile.name}`}
      description="Its conversations, memories, schedules and channels go with it. This cannot be undone."
    >
      {error && (
        <p role="alert" className="text-sm text-bad">
          {error}
        </p>
      )}
      <div>
        <Action tone="danger" onClick={remove} busy={busy} className="border border-bad/40">
          <Trash2 size={15} />
          Delete this agent
        </Action>
      </div>
    </SettingsGroup>
  );
}
