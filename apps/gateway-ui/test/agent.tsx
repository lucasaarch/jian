import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode, Suspense, useState } from 'react';
import type {
  Channel,
  Contact,
  Group,
  Memory,
  ModelDefaults,
  Profile,
  Project,
  Provider,
  ProviderModelList,
  Run,
  Session,
} from '@/lib/api';
import { keys } from '@/lib/query/keys';
import { route } from './route';

/** Any slice of an agent a section reads. What is left out is fetched as the panel would. */
export type AgentSlices = Partial<{
  sessions: Session[];
  projects: Project[];
  channels: Channel[];
  contacts: Contact[];
  memories: Memory[];
  activities: Run[];
  modelDefaults: ModelDefaults;
  groups: Group[];
  providers: Provider[];
  providerModels: Record<string, ProviderModelList>;
}>;

type Seed = {
  profile: Profile;
  profiles?: Profile[];
  slices?: AgentSlices;
  /** More of the URL than the agent, such as the open conversation. */
  params?: Record<string, string>;
};

/**
 * A cache holding the agent's slices before the first render, which never go stale. In a unit
 * test it also places the agent in the URL; Storybook takes it from the story's parameters.
 * A test that changes the data later keeps the client and writes to it.
 */
export function agentClient({ profile, profiles = [profile], slices = {}, params = {} }: Seed) {
  const cache = new QueryClient({
    defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY, retry: false } },
  });
  const id = profile.id;
  const { providerModels, groups, providers, ...owned } = slices;
  const byAgent = {
    sessions: keys.sessions,
    projects: keys.projects,
    channels: keys.channels,
    contacts: keys.contacts,
    memories: keys.memories,
    activities: keys.activities,
    modelDefaults: keys.modelDefaults,
  } as const;

  cache.setQueryData(keys.profiles, profiles);
  if (groups) cache.setQueryData(keys.groups, groups);
  if (providers) cache.setQueryData(keys.providers, providers);
  for (const list of Object.values(providerModels ?? {})) {
    cache.setQueryData(keys.providerModels(list.providerId), list);
  }
  for (const [slice, value] of Object.entries(owned)) {
    cache.setQueryData(byAgent[slice as keyof typeof byAgent](id), value);
  }
  route.params = { profileId: id, ...params };

  return cache;
}

/** Renders a section on data the caller chooses, with no gateway behind it. */
export function AgentCache({
  client,
  children,
  ...seed
}: Seed & { client?: QueryClient; children: ReactNode }) {
  const [cache] = useState(() => client ?? agentClient(seed));

  return (
    <QueryClientProvider client={cache}>
      <Suspense fallback={null}>{children}</Suspense>
    </QueryClientProvider>
  );
}
