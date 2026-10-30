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
  // Every connected account's repositories, read from GitHub: kept for a few minutes so each
  // new chat's composer opens its list at once instead of asking GitHub again.
  githubRepositories: () =>
    queryOptions({
      queryKey: keys.githubRepositories,
      queryFn: () => panelApi().githubRepositories(),
      staleTime: 5 * 60_000,
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
  /** What kind of gateway this is; it does not change while the panel runs. */
  gateway: () =>
    queryOptions({
      queryKey: keys.gateway,
      queryFn: () => panelApi().health(),
      staleTime: Number.POSITIVE_INFINITY,
    }),
  remoteMachines: () =>
    queryOptions({ queryKey: keys.remoteMachines, queryFn: () => panelApi().remoteMachines() }),
  mcpServers: () =>
    queryOptions({ queryKey: keys.mcpServers, queryFn: () => panelApi().mcpServers() }),
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
  /** Read again every two minutes: the windows move with work on any agent, even elsewhere. */
  subscriptionUsage: () =>
    queryOptions({
      queryKey: keys.subscriptionUsage,
      queryFn: () => panelApi().subscriptionUsage(),
      refetchInterval: 120_000,
    }),
  modelDefaults: () =>
    queryOptions({
      queryKey: keys.modelDefaults,
      queryFn: () => panelApi().modelDefaults(),
    }),
};

export function useProfiles() {
  return useQuery(queries.profiles());
}
