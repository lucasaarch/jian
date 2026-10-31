'use client';

import { type ReactNode, Suspense, useCallback, useEffect, useState } from 'react';
import { ChatNotices } from '../components/notifications/chat-notices';
import { Sessions } from '../components/sessions';
import { Action } from '../kit';
import type { Profile } from '../lib/api';
import { agentPath } from '../lib/navigation';
import { usePhone } from '../lib/phone';
import { useProfiles } from '../lib/query/profile';
import { useEventStream } from '../lib/query/stream';
import { useLastProfile } from '../lib/stores/last-profile';
import { useSavedLayout } from '../lib/stores/layout';
import { useOnboarding } from '../lib/stores/onboarding';
import { useActions, useAdoptProfile, useProfileId } from '../lib/workspace';
import { usePathname, useRouter, useSearchParams } from '../platform/navigation';
import { AgentOverlays } from './agent-overlays';
import { AgentPicker } from './agent-picker';
import { ChatSearch } from './chat-search';
import { ChatSidebar } from './chat-sidebar';
import { ChatsLoading } from './chats-loading';
import { useAgentCommands } from './commands/agent-commands';
import { ReadFailed } from './failed';
import { PhoneBar } from './phone-bar';
import { Welcome } from './welcome';
import { WelcomeHandoff } from './welcome/handoff';

/**
 * The app's one screen: the sidebar of an agent's conversations and the open one. Opened on no
 * agent, it goes to the last one used, or the first; with none, it offers to create one. On a
 * phone the sidebar and what it opens take turns, the sidebar first. `header` is what a host
 * draws over the sidebar's top — the web's bar; a native host draws its own title bar instead.
 */
export function ChatsApp({ createAgent, header }: { createAgent: () => void; header?: ReactNode }) {
  const [welcomeAgent, setWelcomeAgent] = useState<Profile>();
  const adopt = useAdoptProfile();
  const onboarding = useOnboarding();
  const profileId = useProfileId();
  const profiles = useProfiles().data;
  const known = profiles?.some((profile) => profile.id === profileId) ?? false;
  // Until an agent is open there is nothing to list, unless there is no agent at all.
  const loading = !profiles || (profiles.length > 0 && !known);
  const pathname = usePathname();
  const search = useSearchParams();
  const phone = usePhone();
  // Something the sidebar opened: a chat, or a new one.
  const opened = /\/sessions\/[^/]+/.test(pathname) || search.has('new');
  const sidebar = !phone || (known && !opened);
  const main = !phone || !sidebar;
  useSavedLayout();
  const finishWelcome = useCallback(
    (profile: Profile) => {
      adopt(profile, 'sessions?new&welcome');
      setWelcomeAgent(undefined);
      onboarding.finish();
    },
    [adopt, onboarding.finish],
  );

  const welcoming = Boolean(profiles) && (!onboarding.completed || onboarding.requested);
  const setShowing = onboarding.setShowing;
  useAgentCommands({
    profiles: welcoming ? undefined : profiles,
    current: profiles?.find((profile) => profile.id === profileId),
    createAgent,
  });
  // A host hides its own chrome — title bar buttons, status bar — while the Welcome is up.
  useEffect(() => {
    setShowing(welcoming);
    return () => setShowing(false);
  }, [welcoming, setShowing]);

  return (
    <WelcomeHandoff
      welcome={
        welcoming ? (
          <Welcome saved={welcomeAgent} onCreated={setWelcomeAgent} finish={finishWelcome} />
        ) : null
      }
    >
      <div className="relative flex h-(--app-height) overflow-hidden">
        {sidebar && header}
        <ReadFailed>
          {sidebar && (
            <ChatSidebar
              {...(profileId && known ? { profileId } : {})}
              loading={loading}
              footer={<AgentPicker createAgent={createAgent} />}
            />
          )}
          {main && (
            <div data-app-main className="min-w-0 flex-1">
              <Chats phone={phone} createAgent={createAgent} />
            </div>
          )}
          {/* Beside both: on a phone the sidebar opens them with no conversation on screen. */}
          {profileId && known && (
            <Suspense fallback={null}>
              <AgentOverlays profileId={profileId} />
            </Suspense>
          )}
        </ReadFailed>
      </div>
    </WelcomeHandoff>
  );
}

function Chats({ phone, createAgent }: { phone: boolean; createAgent: () => void }) {
  const profiles = useProfiles().data;
  const profileId = useProfileId();
  const last = useLastProfile((state) => state.profileId);
  const router = useRouter();
  const known = profiles?.some((profile) => profile.id === profileId) ?? false;

  useEffect(() => {
    if (!profiles?.length || known) return;
    const next = profiles.find((profile) => profile.id === last) ?? profiles[0];
    if (next) router.replace(agentPath(next.id, 'sessions'));
  }, [profiles, known, last, router]);

  if (!profiles) return <ChatsLoading label="Loading agents" />;
  if (!profiles.length)
    return (
      <main className="grid h-full place-content-center justify-items-center gap-4 px-6 text-center">
        <h1 className="text-xl font-semibold">A place for your next agent</h1>
        <Action tone="primary" onClick={createAgent}>
          Create an agent
        </Action>
      </main>
    );

  // Between the agents arriving and the address naming one of them, as it is about to.
  if (!profileId || !known) return <ChatsLoading />;

  return (
    <Suspense fallback={<ChatsLoading />}>
      <AgentChats key={profileId} profileId={profileId} phone={phone} />
    </Suspense>
  );
}

function AgentChats({ profileId, phone }: { profileId: string; phone: boolean }) {
  const actions = useActions();
  const remember = useLastProfile((state) => state.remember);
  useEventStream(profileId);
  useEffect(() => remember(profileId), [profileId, remember]);

  return (
    <main className="flex h-full flex-col overflow-hidden">
      <ChatNotices profileId={profileId} />
      {phone && <PhoneBar profileId={profileId} />}
      <div className="min-h-0 flex-1">
        <Sessions {...actions} />
      </div>
      <ChatSearch profileId={profileId} />
    </main>
  );
}
