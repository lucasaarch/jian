'use client';

import { useIsMutating, useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { toast } from 'sonner';
import type { SectionActions } from '../components/props';
import { useParams, useRouter } from '../platform/navigation';
import type { Mutation, Profile } from './api';
import { agentPath } from './navigation';
import { panelApi } from './query/client';
import { keys } from './query/keys';
import { queries, useProfiles } from './query/profile';
import { draftKey, useDrafts } from './stores/drafts';
import { useLastProfile } from './stores/last-profile';

/**
 * The workspace is the URL plus the query cache: the open agent is the `[profileId]` segment,
 * everything about it is a cached query, and an action invalidates what it changed. Nothing
 * here is held in React context.
 */

/** Shows a failure the way every screen of the panel does. */
export function notifyError(error: unknown, fallback: string) {
  toast.error(error instanceof Error ? error.message : fallback, { duration: 8000 });
}

/** The agent in the URL, or undefined on a page that belongs to none. */
export function useProfileId(): string | undefined {
  const { profileId } = useParams<{ profileId?: string }>();

  return profileId ? decodeURIComponent(profileId) : undefined;
}

/**
 * The agent the owner is working with: the one in the address, or, on a gateway screen that
 * belongs to none, the one they had open last while it still exists.
 */
export function useWorkingAgentId(): string | undefined {
  const inAddress = useProfileId();
  const last = useLastProfile((state) => state.profileId);
  const profiles = useProfiles().data ?? [];

  if (inAddress) return inAddress;

  return (profiles.find((profile) => profile.id === last) ?? profiles[0])?.id;
}

/** True while an action runs; a section disables its controls instead of queueing a second. */
function useBusy(): boolean {
  return useIsMutating() > 0;
}

/**
 * Reads the open agent again, with the installation-wide lists it shows. The providers' model
 * lists are included: this is the one place they are asked for again.
 */
export function useRefresh(): () => Promise<void> {
  const client = useQueryClient();
  const profileId = useProfileId();

  return useCallback(async () => {
    await Promise.all([
      client.invalidateQueries({ queryKey: keys.profiles }),
      client.invalidateQueries({ queryKey: keys.providers }),
      client.invalidateQueries({ queryKey: keys.modelDefaults }),
      client.invalidateQueries({ queryKey: keys.mcpServers }),
      client.invalidateQueries({ queryKey: keys.groups }),
      profileId ? client.invalidateQueries({ queryKey: keys.profile(profileId) }) : undefined,
    ]);
  }, [client, profileId]);
}

/** Runs an action, shows its outcome and reloads the agent. False means it failed. */
function useMutate(): Mutation {
  const refresh = useRefresh();
  const { mutateAsync } = useMutation({
    mutationFn: async ({
      action,
      message,
    }: {
      action: () => Promise<unknown>;
      message: string;
    }) => {
      await action();
      toast.success(message);
      // Inside the mutation, so the section stays busy until it shows what the action changed.
      await refresh();
    },
  });

  return useCallback(
    (action, message = 'Changes saved.') =>
      mutateAsync({ action, message }).then(
        () => true,
        (error: unknown) => {
          notifyError(error, 'The action could not be completed.');

          return false;
        },
      ),
    [mutateAsync],
  );
}

/** The ways a section acts, which every page hands its section. */
export function useActions(): SectionActions {
  return { api: panelApi(), mutate: useMutate(), busy: useBusy() };
}

/**
 * Removes a conversation from the list at once. An in-flight read of the list is cancelled
 * first, so an answer that started before the delete cannot put the row back.
 */
export function useDeleteConversation(): (sessionId: string) => Promise<boolean> {
  const client = useQueryClient();
  const profileId = useProfileId();
  const { mutateAsync } = useMutation({
    mutationFn: (sessionId: string) => {
      if (!profileId) throw new Error('No agent is open.');

      return panelApi().deleteSession(profileId, sessionId);
    },
  });

  return useCallback(
    async (sessionId) => {
      if (!profileId) return false;

      try {
        await mutateAsync(sessionId);
      } catch (error) {
        notifyError(error, 'The conversation could not be deleted.');

        return false;
      }

      useDrafts.getState().write(draftKey(profileId, sessionId), '');
      await client.cancelQueries({ queryKey: keys.sessions(profileId) });
      // The key from the query's own options carries its type, so the update is checked.
      client.setQueryData(queries.sessions(profileId).queryKey, (sessions = []) =>
        sessions.filter((session) => session.id !== sessionId),
      );
      toast.success('Conversation deleted.');

      return true;
    },
    [client, mutateAsync, profileId],
  );
}

/** Adds a profile the owner just created and opens it. */
export function useAdoptProfile(): (profile: Profile, path?: string) => void {
  const client = useQueryClient();
  const router = useRouter();

  return useCallback(
    (created, path = '') => {
      client.setQueryData(queries.profiles().queryKey, (profiles = []) => [
        ...profiles.filter((item) => item.id !== created.id),
        created,
      ]);
      router.push(agentPath(created.id, path));
    },
    [client, router],
  );
}

/** Ends the panel session; nothing cached for it survives into the next one. */
export function useSignOut(): () => Promise<void> {
  const client = useQueryClient();
  const router = useRouter();

  return useCallback(async () => {
    await panelApi()
      .signOut()
      .catch(() => undefined);
    router.replace('/sign-in');
    client.clear();
    useDrafts.getState().forgetAll();
  }, [client, router]);
}
