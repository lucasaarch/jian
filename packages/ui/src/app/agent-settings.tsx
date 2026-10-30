'use client';

import { useQueryClient } from '@tanstack/react-query';
import { RotateCcw, Trash2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { toast } from 'sonner';
import { Action, ConfirmDialog, SettingsGroup, SettingsRow } from '../kit';
import type { Profile } from '../lib/api';
import { panelApi } from '../lib/query/client';
import { queries, useProfiles } from '../lib/query/profile';
import { useLastProfile } from '../lib/stores/last-profile';
import { useRefresh } from '../lib/workspace';
import { useRouter } from '../platform/navigation';
import { AgentAvatar } from './agent-avatar';
import { AgentIdentity } from './agent-identity';

/**
 * One agent's settings, in the conversation's place: who it is, saved as it is typed, and what
 * cannot be taken back — forgetting everything it was told, or deleting it.
 */
export function AgentSettingsContent({ profileId }: { profileId: string }) {
  const profile = useProfiles().data?.find((item) => item.id === profileId);
  if (!profile) return null;

  return (
    <>
      <header className="flex items-center gap-3.5">
        <AgentAvatar profile={profile} size={3} />
        <div className="grid min-w-0">
          <h2 className="truncate font-sans text-base font-semibold tracking-tight">
            {profile.name}
          </h2>
          {profile.summary && <p className="truncate text-[13px] text-muted">{profile.summary}</p>}
        </div>
      </header>
      <AgentIdentity key={profile.id} profile={profile} />
      <DangerZone profile={profile} />
    </>
  );
}

function DangerZone({ profile }: { profile: Profile }) {
  const client = useQueryClient();
  const router = useRouter();
  const refresh = useRefresh();
  const forget = useLastProfile((state) => state.forget);
  const [working, setWorking] = useState<'reset' | 'delete'>();
  const [asking, setAsking] = useState<'reset' | 'delete'>();

  const reset = async () => {
    setWorking('reset');
    try {
      const { sessions, memories } = await panelApi().resetProfile(profile.id);
      toast.success(
        `${profile.name} forgot ${sessions === 1 ? '1 conversation' : `${sessions} conversations`} and ${
          memories === 1 ? '1 memory' : `${memories} memories`
        }.`,
      );
      // Its conversations are gone; so is what was kept of them.
      client.removeQueries({ queryKey: ['history', profile.id] });
      await refresh();
      setAsking(undefined);
    } catch (failure) {
      toast.error(failure instanceof Error ? failure.message : 'The agent could not be reset.');
    } finally {
      setWorking(undefined);
    }
  };

  const remove = async () => {
    setWorking('delete');
    try {
      await panelApi().deleteProfile(profile.id);
      client.setQueryData(queries.profiles().queryKey, (profiles = []) =>
        profiles.filter((item) => item.id !== profile.id),
      );
      client.removeQueries({ queryKey: ['history', profile.id] });
      toast.success(`${profile.name} was deleted.`);
      forget(profile.id);
      // The chats screen opens the next agent's chats, or offers to create one.
      router.replace('/');
    } catch (failure) {
      toast.error(failure instanceof Error ? failure.message : 'The agent could not be deleted.');
      setWorking(undefined);
    }
  };

  const button = (which: 'reset' | 'delete', icon: ReactNode, label: string) => (
    <Action
      tone="danger"
      size="small"
      className="border border-bad/40"
      onClick={() => setAsking(which)}
    >
      {icon}
      {label}
    </Action>
  );

  return (
    <>
      <SettingsGroup title="Danger zone">
        <SettingsRow
          title="Reset"
          description="Forgets its conversations, memories and activity. Who it is, its channels and contacts stay."
        >
          {button('reset', <RotateCcw size={13} />, 'Reset')}
        </SettingsRow>
        <SettingsRow
          title="Delete"
          description="It goes with everything it has: conversations, memories, schedules and channels."
        >
          {button('delete', <Trash2 size={13} />, 'Delete')}
        </SettingsRow>
      </SettingsGroup>
      <ConfirmDialog
        open={asking === 'reset'}
        onOpenChange={(open) => !open && setAsking(undefined)}
        title={`Reset ${profile.name}?`}
        phrase={profile.name}
        action="Reset agent"
        run={() => void reset()}
        busy={working === 'reset'}
      >
        It forgets every conversation, memory and bit of activity. Who it is, its channels and its
        contacts stay. This cannot be undone.
      </ConfirmDialog>
      <ConfirmDialog
        open={asking === 'delete'}
        onOpenChange={(open) => !open && setAsking(undefined)}
        title={`Delete ${profile.name}?`}
        phrase={profile.name}
        action="Delete agent"
        run={() => void remove()}
        busy={working === 'delete'}
      >
        It goes with its conversations, memories, schedules and channels. This cannot be undone.
      </ConfirmDialog>
    </>
  );
}
