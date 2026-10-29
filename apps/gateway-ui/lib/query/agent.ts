'use client';

import { type UseQueryResult, useQueries, useSuspenseQuery } from '@tanstack/react-query';
import { useParams } from 'next/navigation';
import { useMemo } from 'react';
import type { ModelCatalog, Profile, ProviderModelList } from '@/lib/api';
import { queries } from './profile';

/**
 * The open agent's data, one slice per hook. Each suspends until its slice has arrived once, so
 * a section reads exactly what it shows and never handles a missing value: the agent layout's
 * boundary shows the wait, its error page the failure. Only for pages under `/agents/:id`.
 */

/** The agent in the URL. Throws outside `/agents/:id`, where no section is rendered. */
export function useAgentId(): string {
  const { profileId } = useParams<{ profileId?: string }>();

  if (!profileId) throw new Error('useAgentId outside an agent route');

  return decodeURIComponent(profileId);
}

/** The open agent. The layout renders nothing under an id that is not in the list. */
export function useAgent(): Profile {
  const profileId = useAgentId();
  const profile = useSuspenseQuery(queries.profiles()).data.find((item) => item.id === profileId);

  if (!profile) throw new Error(`No agent ${profileId}`);

  return profile;
}

/** Every agent of the installation, for a screen that names or offers the others. */
export const useAgents = () => useSuspenseQuery(queries.profiles()).data;

export const useSessions = () => useSuspenseQuery(queries.sessions(useAgentId())).data;
export const useProjects = () => useSuspenseQuery(queries.projects(useAgentId())).data;
export const useChannels = () => useSuspenseQuery(queries.channels(useAgentId())).data;
export const useContacts = () => useSuspenseQuery(queries.contacts(useAgentId())).data;
export const useMemories = () => useSuspenseQuery(queries.memories(useAgentId())).data;
export const useActivities = () => useSuspenseQuery(queries.activities(useAgentId())).data;
export const useModelDefaults = () => useSuspenseQuery(queries.modelDefaults(useAgentId())).data;
export const useGroups = () => useSuspenseQuery(queries.groups()).data;
export const useProviders = () => useSuspenseQuery(queries.providers()).data;

/** Defined once, outside a render, so the combined map keeps its identity between renders. */
const byProvider = (results: UseQueryResult<ProviderModelList>[]) =>
  Object.fromEntries(
    results.flatMap((list) => (list.data ? [[list.data.providerId, list.data] as const] : [])),
  );

/**
 * The models each usable provider offers, keyed by provider id. Not waited for: a provider
 * whose list has not arrived is simply absent, and a section reads that as "not listed yet".
 */
export function useProviderModels(): Record<string, ProviderModelList> {
  const providers = useProviders();

  return useQueries({
    queries: providers
      .filter((provider) => !provider.revokedAt)
      .map((provider) => queries.providerModels(provider.id)),
    combine: byProvider,
  });
}

/** What a model is chosen from: the providers, what each offers, and the agent's defaults. */
export function useModelCatalog(): ModelCatalog {
  const providers = useProviders();
  const providerModels = useProviderModels();
  const modelDefaults = useModelDefaults();

  return useMemo(
    () => ({ providers, providerModels, modelDefaults }),
    [providers, providerModels, modelDefaults],
  );
}
