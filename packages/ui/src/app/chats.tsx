'use client';

import { type ReactNode, Suspense, useCallback, useEffect, useRef, useState } from 'react';
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
import { ChatCommands } from './commands/chat-commands';
import { ReadFailed } from './failed';
import { Onboarding } from './onboarding';
import { Farewell } from './onboarding/farewell';
import { StageHandoff } from './onboarding/handoff';
import { rememberWelcome, Welcome, welcomed } from './onboarding/welcome';
import { PhoneBar } from './phone-bar';
import { LoadingMark } from './reload';

/** How long the mark covers the window for a gateway that does not answer, in milliseconds. */
const LOADING_PATIENCE = 15_000;

/**
 * The app's one screen: the sidebar of an agent's conversations and the open one. Opened on no
 * agent, it goes to the last one used, or the first; with none, it offers to create one. On a
 * phone the sidebar and what it opens take turns, the sidebar first. `header` is what a host
 * draws over the sidebar's top — the web's bar; a native host draws its own title bar instead.
 */
export function ChatsApp({
  welcomes = false,
  header,
}: {
  /**
   * Welcomes the owner on opening, landing on a new chat: an app that is launched. A page's address
   * may name what it was opened for, so a browser goes straight there.
   */
  welcomes?: boolean;
  header?: ReactNode;
}) {
  const [onboardingAgent, setOnboardingAgent] = useState<Profile>();
  const adopt = useAdoptProfile();
  const onboarding = useOnboarding();
  const profileId = useProfileId();
  const read = useProfiles();
  const profiles = read.data;
  const lastProfile = useLastProfile((state) => state.profileId);
  const [owed, setOwed] = useState(() => welcomes && !welcomed());
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
  const finishOnboarding = useCallback(
    (profile: Profile) => {
      adopt(profile, 'sessions?new&arriving');
      setOnboardingAgent(undefined);
      onboarding.finish();
    },
    [adopt, onboarding.finish],
  );

  const creating = onboarding.creating;
  const onboardingUp =
    Boolean(profiles) && (!onboarding.completed || onboarding.requested || creating);
  // Not known yet, with nothing kept from before. A failed read leaves it to the app, which says
  // so; a gateway that never answers does too in time, as the mark covers the way to another.
  const [patient, setPatient] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => setPatient(false), LOADING_PATIENCE);
    return () => clearTimeout(timer);
  }, []);
  const booting = !profiles && !read.isError && patient;
  const welcomeBack =
    owed && !onboardingUp
      ? (profiles?.find((profile) => profile.id === profileId) ??
        profiles?.find((profile) => profile.id === lastProfile) ??
        profiles?.[0])
      : undefined;
  // Coming back is only worth saying to someone with an agent to come back to.
  useEffect(() => {
    if (owed && profiles && !welcomeBack) {
      rememberWelcome();
      setOwed(false);
    }
  }, [owed, profiles, welcomeBack]);
  // Opened for something — a notification, the tray — while the welcome played: that place stays.
  const openedOn = useRef(pathname);
  const location = useRef(pathname);
  location.current = pathname;
  const finishWelcome = useCallback(
    (profile: Profile) => {
      if (location.current === openedOn.current) adopt(profile, 'sessions?new&arriving');
      setOwed(false);
    },
    [adopt],
  );
  const departed = onboarding.departed;
  const staged = onboardingUp || booting || Boolean(welcomeBack) || Boolean(departed);
  const setShowing = onboarding.setShowing;
  const createAgent = onboarding.create;
  useAgentCommands({
    profiles: staged ? undefined : profiles,
    current: profiles?.find((profile) => profile.id === profileId),
    createAgent,
  });
  // A host hides its own chrome — title bar buttons, status bar — while a stage is up.
  useEffect(() => {
    setShowing(staged);
    return () => setShowing(false);
  }, [staged, setShowing]);

  return (
    <StageHandoff
      welcome={
        departed ? (
          <Farewell agent={departed} done={onboarding.seenOff} />
        ) : booting ? (
          <LoadingMark label="Loading agents" />
        ) : welcomeBack ? (
          <Welcome profile={welcomeBack} finish={finishWelcome} />
        ) : onboardingUp ? (
          <Onboarding
            saved={onboardingAgent}
            onCreated={setOnboardingAgent}
            finish={finishOnboarding}
            creating={creating}
            cancel={onboarding.cancelCreating}
          />
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
    </StageHandoff>
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
      <ChatCommands profileId={profileId} />
    </main>
  );
}
