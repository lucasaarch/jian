import { queryOptions, useQuery } from '@tanstack/react-query';
import type { ProviderModelList } from '../api';
import { panelApi } from './client';
import { keys } from './keys';

/**
 * The options of every query the open profile is read through, so a section that needs one
 * slice asks for exactly that slice and shares its cache with everyone else who reads it.
 */
export const queries = {
  /** Also the session check: without a valid cookie this is the first call to fail. */
  profiles: () =>
    queryOptions({ queryKey: keys.profiles, queryFn: () => panelApi().profiles(), retry: false }),
  providers: () =>
    queryOptions({ queryKey: keys.providers, queryFn: () => panelApi().providers() }),
  /**
   * A provider that is down answers with an empty, stale list instead of failing, so one
   * unreachable vendor cannot blank the panel. The gateway caches the answer too; this is only
   * read again when the owner refreshes or changes something.
   */
  providerModels: (providerId: string) =>
    queryOptions({
      queryKey: keys.providerModels(providerId),
      queryFn: () =>
        panelApi()
          .providerModels(providerId)
          .catch(
            (error): ProviderModelList => ({
              providerId,
              models: [],
              fetchedAt: new Date().toISOString(),
              stale: true,
              reason: error instanceof Error ? error.message : 'The list is unavailable.',
            }),
          ),
      staleTime: Number.POSITIVE_INFINITY,
    }),
  groups: () => queryOptions({ queryKey: keys.groups, queryFn: () => panelApi().groups() }),
  /** The installation's GitHub App and the accounts it is installed on. */
  githubIntegration: () =>
    queryOptions({
      queryKey: keys.githubIntegration,
      queryFn: () => panelApi().githubIntegration(),
    }),
  githubRepositories: (accountId: string) =>
    queryOptions({
      queryKey: keys.githubRepositories(accountId),
      queryFn: () => panelApi().githubRepositories(accountId),
    }),
  /**
   * What this installation runs and what changed. Read once a visit: it only moves with an
   * update, and a panel that cannot say what changed still works, so a failure stays quiet.
   */
  releases: () =>
    queryOptions({
      queryKey: keys.releases,
      queryFn: () => panelApi().releases(),
      staleTime: Number.POSITIVE_INFINITY,
      retry: false,
    }),
  /** Jian's repository on GitHub, for the star count in the sidebar. Never retried. */
  repository: () =>
    queryOptions({
      queryKey: keys.repository,
      queryFn: () => panelApi().repository(),
      staleTime: Number.POSITIVE_INFINITY,
      retry: false,
    }),
  remoteMachines: () =>
    queryOptions({ queryKey: keys.remoteMachines, queryFn: () => panelApi().remoteMachines() }),
  sessions: (profileId: string) =>
    queryOptions({
      queryKey: keys.sessions(profileId),
      queryFn: () => panelApi().sessions(profileId),
    }),
  projects: (profileId: string) =>
    queryOptions({
      queryKey: keys.projects(profileId),
      queryFn: () => panelApi().projects(profileId),
    }),
  channels: (profileId: string) =>
    queryOptions({
      queryKey: keys.channels(profileId),
      queryFn: () => panelApi().channels(profileId),
    }),
  contacts: (profileId: string) =>
    queryOptions({
      queryKey: keys.contacts(profileId),
      queryFn: () => panelApi().contacts(profileId),
    }),
  memories: (profileId: string) =>
    queryOptions({
      queryKey: keys.memories(profileId),
      queryFn: () => panelApi().memories(profileId),
    }),
  activities: (profileId: string) =>
    queryOptions({
      queryKey: keys.activities(profileId),
      queryFn: () => panelApi().activities(profileId),
    }),
  modelDefaults: (profileId: string) =>
    queryOptions({
      queryKey: keys.modelDefaults(profileId),
      queryFn: () => panelApi().modelDefaults(profileId),
    }),
};

export function useProfiles() {
  return useQuery(queries.profiles());
}
