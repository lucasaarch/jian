'use client';

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  type GatewayApi,
  gatewayApi,
  type Mutation,
  type Profile,
  type ProfileData,
  type ProviderModelList,
} from './api';

export type Notice = { text: string; error: boolean };

type Workspace = {
  api: GatewayApi;
  profiles: Profile[];
  /** The open profile, or undefined while the first load is still in flight. */
  profile: Profile | undefined;
  /** The open profile's data, present only when it belongs to the open profile. */
  data: ProfileData | undefined;
  selected: string;
  select: (profileId: string) => void;
  adopt: (profile: Profile) => void;
  /**
   * Deletes the profile on the gateway, then drops it locally and selects whatever remains.
   * A bespoke action rather than `mutate` + a local `remove`, because `mutate`'s own refresh
   * would run first, still pointed at the profile this just deleted — and fail loading it.
   */
  deleteProfile: (profileId: string) => Promise<boolean>;
  refresh: () => Promise<void>;
  mutate: Mutation;
  notice: Notice | undefined;
  setNotice: (notice: Notice | undefined) => void;
  loading: boolean;
  busy: boolean;
  signOut: () => Promise<void>;
};

const WorkspaceContext = createContext<Workspace | undefined>(undefined);

/** Every page reads the open profile from here; none of them loads it again. */
export function useWorkspace(): Workspace {
  const workspace = useContext(WorkspaceContext);

  if (!workspace) {
    throw new Error('useWorkspace outside the workspace layout');
  }

  return workspace;
}

/**
 * The open profile's whole screenful, in one pass. A provider that is down answers with an
 * empty, stale list instead of failing the load, so one unreachable vendor cannot blank the
 * panel.
 */
async function profileData(api: GatewayApi, id: string): Promise<ProfileData> {
  const [
    sessions,
    channels,
    contacts,
    groups,
    memories,
    activities,
    deliveries,
    providers,
    modelDefaults,
  ] = await Promise.all([
    api.sessions(id),
    api.channels(id),
    api.contacts(id),
    api.groups(),
    api.memories(id),
    api.activities(id),
    api.deliveries(id),
    api.providers(),
    api.modelDefaults(id),
  ]);

  // One request per live provider, and only on a refresh: the gateway caches the answer, so
  // rendering the panel never costs a call to the provider.
  const lists = await Promise.all(
    providers
      .filter((provider) => !provider.revokedAt)
      .map(async (provider) =>
        api.providerModels(provider.id).catch(
          (error): ProviderModelList => ({
            providerId: provider.id,
            models: [],
            fetchedAt: new Date().toISOString(),
            stale: true,
            reason: error instanceof Error ? error.message : 'The list is unavailable.',
          }),
        ),
      ),
  );

  return {
    sessions,
    channels,
    contacts,
    groups,
    memories,
    activities,
    deliveries,
    providers,
    providerModels: Object.fromEntries(lists.map((list) => [list.providerId, list])),
    modelDefaults,
  };
}

export function WorkspaceProvider({
  initialProfiles,
  onSignOut,
  children,
}: {
  initialProfiles: Profile[];
  onSignOut: () => void;
  children: ReactNode;
}) {
  const api = useMemo(() => gatewayApi(), []);
  const [profiles, setProfiles] = useState(initialProfiles);
  const [selected, setSelected] = useState(initialProfiles[0]?.id ?? '');
  const [held, setHeld] = useState<{ profileId: string; value: ProfileData }>();
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>();
  // A load that started before a profile switch must not overwrite the one that follows it.
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    const current = ++generation.current;

    setLoading(true);

    try {
      const [updated, details] = await Promise.all([
        api.profiles(),
        selected ? profileData(api, selected) : undefined,
      ]);

      if (current !== generation.current) {
        return;
      }

      setProfiles(updated);

      if (details) {
        setHeld({ profileId: selected, value: details });
      }
    } catch (error) {
      if (current === generation.current) {
        setNotice({
          text: error instanceof Error ? error.message : 'The data could not be refreshed.',
          error: true,
        });
      }
    } finally {
      if (current === generation.current) {
        setLoading(false);
      }
    }
  }, [api, selected]);

  useEffect(() => {
    void refresh();

    return () => {
      generation.current++;
    };
  }, [refresh]);

  // A contact request must reach the owner without a reload: the gateway already streams
  // every profile event, and a dropped stream is reopened from the last event seen.
  useEffect(() => {
    if (!selected) {
      return;
    }

    const controller = new AbortController();
    let cursor = 0;
    let timer: ReturnType<typeof setTimeout>;

    const listen = async () => {
      try {
        await api.events(
          selected,
          cursor,
          (event) => {
            cursor = event.id;

            if (event.type.startsWith('contact.') || event.type.startsWith('channel.')) {
              void refresh();
            }
          },
          controller.signal,
        );
      } catch {
        // A stream ends on shutdown, on a lost network or when the session expires.
      }

      if (!controller.signal.aborted) {
        timer = setTimeout(() => void listen(), 5000);
      }
    };

    void listen();

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [api, selected, refresh]);

  const mutate: Mutation = async (action, message = 'Changes saved.') => {
    setBusy(true);
    setNotice(undefined);

    try {
      await action();
      setNotice({ text: message, error: false });
      await refresh();

      return true;
    } catch (error) {
      setNotice({
        text: error instanceof Error ? error.message : 'The action could not be completed.',
        error: true,
      });

      return false;
    } finally {
      setBusy(false);
    }
  };

  const profile = profiles.find((item) => item.id === selected);

  const value: Workspace = {
    api,
    profiles,
    profile,
    data: held?.profileId === selected ? held.value : undefined,
    selected,
    select: (profileId) => {
      setSelected(profileId);
      setNotice(undefined);
    },
    adopt: (created) => {
      setProfiles((current) => [...current, created]);
      setSelected(created.id);
    },
    deleteProfile: async (profileId) => {
      setBusy(true);
      setNotice(undefined);

      try {
        await api.deleteProfile(profileId);
      } catch (error) {
        setNotice({
          text: error instanceof Error ? error.message : 'The profile could not be deleted.',
          error: true,
        });
        setBusy(false);

        return false;
      }

      const remaining = profiles.filter((item) => item.id !== profileId);
      const next = selected === profileId ? (remaining[0]?.id ?? '') : selected;

      setProfiles(remaining);
      setSelected(next);
      setHeld((current) => (current?.profileId === profileId ? undefined : current));
      setNotice({ text: 'Profile deleted.', error: false });
      setBusy(false);

      // Refreshes against the new selection, not the one that no longer exists.
      if (next) {
        await profileData(api, next)
          .then((value) => setHeld({ profileId: next, value }))
          .catch(() => undefined);
      }

      return true;
    },
    refresh,
    mutate,
    notice,
    setNotice,
    loading,
    busy,
    signOut: async () => {
      await api.signOut().catch(() => undefined);
      onSignOut();
    },
  };

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

/**
 * The pair every section needs: the open profile and its data. Undefined while the first load
 * runs, which is what lets a page render its own empty state instead of a shared spinner.
 */
export function useOpenProfile(): { profile: Profile; data: ProfileData } | undefined {
  const { profile, data } = useWorkspace();

  return profile && data ? { profile, data } : undefined;
}

/**
 * The props every section component takes. The layout only renders a section once the open
 * profile and its data are both present, so a section never has to handle their absence.
 */
export function useSection() {
  const { profile, data, api, mutate, busy } = useWorkspace();

  if (!profile || !data) {
    throw new Error('section rendered before the profile loaded');
  }

  return { profile, data, api, mutate, busy };
}
