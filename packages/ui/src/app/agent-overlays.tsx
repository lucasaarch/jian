'use client';

import { Brain, MessagesSquare, Sparkles, UserRound } from 'lucide-react';
import { Suspense, useEffect } from 'react';
import { Page, SettingsLayout, type SettingsPage } from '../kit';
import { useGatewayMode } from '../lib/gateway-mode';
import { activityPath, agentPath } from '../lib/navigation';
import { useContacts } from '../lib/query/agent';
import { type AgentSettingsPage, useAgentOverlay } from '../lib/stores/agent-overlay';
import { usePathname, useRouter } from '../platform/navigation';
import { AgentSettingsContent } from './agent-settings';
import { ChannelsPage, ChannelsWaiting } from './customize/channels-page';
import { MemoriesPage, MemoriesWaiting } from './customize/memories-page';
import { SkillsPage, SkillsWaiting } from './customize/skills-page';
import { SchedulesOverlay } from './schedules/schedules-content';

/**
 * What an address from before these were overlays asks to open. Links and bookmarks keep working:
 * the overlay opens, and the address goes on to the agent's chats.
 */
function askedAt(pathname: string): AgentSettingsPage | 'schedules' | 'activity' | undefined {
  // The agent's own address was its Overview, which is its Activity now.
  if (/^\/agents\/[^/]+\/?$/.test(pathname)) return 'activity';
  if (/^\/agents\/[^/]+\/settings\/?$/.test(pathname)) return 'identity';
  if (/^\/agents\/[^/]+\/schedules\/?$/.test(pathname)) return 'schedules';
  const customize = /^\/agents\/[^/]+\/customize(?:\/([^/]+))?\/?$/.exec(pathname);
  if (!customize) return undefined;
  return customize[1] === 'memories' || customize[1] === 'channels' ? customize[1] : 'skills';
}

/** A count on a line of a list, of what is waiting there. */
export function WaitingCount({ count }: { count: number }) {
  return (
    <span className="grid h-4.5 min-w-4.5 place-items-center rounded-full bg-ink px-1 text-[10px] font-semibold text-canvas">
      {count}
      <span className="sr-only"> waiting for approval</span>
    </span>
  );
}

function AgentSettingsOverlay({ profileId }: { profileId: string }) {
  const asked = useAgentOverlay((state) => state.settings);
  const select = useAgentOverlay((state) => state.openSettings);
  const close = useAgentOverlay((state) => state.closeSettings);
  const contacts = useContacts();
  // Channels are a server's alone; on this computer's gateway there is no such page.
  const server = useGatewayMode() === 'server';
  const pending = contacts.filter((contact) => contact.status === 'pending').length;
  const page = asked === 'channels' && !server ? 'identity' : (asked ?? 'identity');
  const pages: SettingsPage[] = [
    {
      id: 'identity',
      label: 'Identity',
      icon: <UserRound size={15} />,
      keywords: ['name', 'instructions', 'avatar', 'summary', 'reset', 'delete', 'agent'],
    },
    {
      id: 'skills',
      label: 'Skills',
      icon: <Sparkles size={15} />,
      keywords: ['skill', 'abilities', 'import'],
    },
    {
      id: 'memories',
      label: 'Memories',
      icon: <Brain size={15} />,
      keywords: ['memory', 'remember', 'facts'],
    },
    ...(server
      ? [
          {
            id: 'channels',
            label: 'Channels',
            icon: <MessagesSquare size={15} />,
            keywords: ['whatsapp', 'telegram', 'email', 'api', 'connect', 'contacts'],
            ...(pending > 0 ? { trailing: <WaitingCount count={pending} /> } : {}),
          },
        ]
      : []),
  ];

  return (
    <Page open={Boolean(asked)} onClose={close} title="Agent settings">
      <SettingsLayout
        onBack={close}
        pages={pages}
        current={page}
        onSelect={(next) => select(next as AgentSettingsPage)}
        startOnPage={page !== 'identity'}
        wide={page === 'skills' || page === 'memories'}
        ownHeading={page === 'skills' || page === 'memories'}
        searchLabel="Search agent settings"
        backLabel="Agent settings"
      >
        {page === 'identity' ? (
          <AgentSettingsContent profileId={profileId} />
        ) : page === 'skills' ? (
          <Suspense key={page} fallback={<SkillsWaiting />}>
            <SkillsPage />
          </Suspense>
        ) : page === 'memories' ? (
          <Suspense key={page} fallback={<MemoriesWaiting />}>
            <MemoriesPage />
          </Suspense>
        ) : (
          <Suspense key={page} fallback={<ChannelsWaiting />}>
            <ChannelsPage />
          </Suspense>
        )}
      </SettingsLayout>
    </Page>
  );
}

/** What opens over the agent's conversation, wherever in the app it was asked from. */
export function AgentOverlays({ profileId }: { profileId: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const openSettings = useAgentOverlay((state) => state.openSettings);
  const openSchedules = useAgentOverlay((state) => state.openSchedules);
  const asked = askedAt(pathname);
  useEffect(() => {
    if (!asked) return;
    if (asked === 'activity') {
      router.replace(activityPath(profileId));
      return;
    }
    if (asked === 'schedules') openSchedules();
    else openSettings(asked);
    router.replace(agentPath(profileId, 'sessions'));
  }, [asked, openSchedules, openSettings, profileId, router]);

  return (
    <>
      <AgentSettingsOverlay profileId={profileId} />
      <SchedulesOverlay />
    </>
  );
}
