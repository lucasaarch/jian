'use client';

import { type ReactNode, Suspense, useEffect } from 'react';
import { Segmented } from '../kit';
import { useGatewayMode } from '../lib/gateway-mode';
import { agentPath } from '../lib/navigation';
import { useRouter } from '../platform/navigation';
import { AgentSettingsContent } from './agent-settings';
import { ChannelsPage, ChannelsWaiting } from './customize/channels-page';
import { MemoriesPage, MemoriesWaiting } from './customize/memories-page';
import { SkillsPage, SkillsWaiting } from './customize/skills-page';
import { OverviewContent, OverviewWaiting } from './overview/overview-content';
import { SchedulesContent, SchedulesWaiting } from './schedules/schedules-content';

/** What Customize holds for an agent, a tab each. */
export const customizeTabs: string[] = ['skills', 'memories', 'channels'];
export type CustomizeTab = 'skills' | 'memories' | 'channels';

export type AgentPlace = 'overview' | 'schedules' | 'settings' | CustomizeTab;

/**
 * The places of an agent opened in the conversation's place, read from the address: the
 * agent's own address is its Overview; its settings open from the agent picker.
 */
export function agentPlace(pathname: string): AgentPlace | undefined {
  if (/^\/agents\/[^/]+\/?$/.test(pathname)) return 'overview';
  if (/^\/agents\/[^/]+\/settings\/?$/.test(pathname)) return 'settings';
  const match = /^\/agents\/[^/]+\/(schedules|customize)(?:\/([^/]+))?\/?$/.exec(pathname);
  if (!match) return undefined;
  if (match[1] === 'schedules') return 'schedules';
  const tab = match[2];
  return tab === 'memories' || tab === 'channels' ? tab : 'skills';
}

export const schedulesPath = (profileId: string) => agentPath(profileId, 'schedules');
export const customizePath = (profileId: string, tab: CustomizeTab = 'skills') =>
  agentPath(profileId, `customize/${tab}`);

/** Anything open over the page that Escape closes first: an overlay, a menu, a list. */
const OPEN_ABOVE = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';

/**
 * Escape leaves a page in the conversation's place for `back`, the chat open before it, unless
 * something open above the page takes Escape for itself.
 */
export function useEscapeTo(back: string | undefined) {
  const router = useRouter();

  useEffect(() => {
    if (!back) return;
    const leave = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (document.querySelector(OPEN_ABOVE)) return;
      router.push(back);
    };
    window.addEventListener('keydown', leave);
    return () => window.removeEventListener('keydown', leave);
  }, [back, router]);
}

/**
 * A page in the conversation's place: a centred column under its heading. On a phone the bar
 * above it says the title already, so the heading is left to assistive technology.
 */
function Page({
  title,
  wide = false,
  children,
}: {
  title: string;
  /** A page of figures, which takes more of a wide screen than a column of settings. */
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <main className="h-full overflow-y-auto" aria-label={title}>
      <div
        className={`mx-auto grid grid-cols-1 gap-6 px-8 pt-8 pb-16 phone:px-4 phone:pt-4 ${wide ? 'max-w-[56rem]' : 'max-w-[40rem]'}`}
      >
        <h1 className="text-lg font-semibold tracking-tight phone:sr-only">{title}</h1>
        {children}
      </div>
    </main>
  );
}

/** A page reads the agent first; while it does, its place holds the page's shape. */
function Reading({ waiting, children }: { waiting: ReactNode; children: ReactNode }) {
  return <Suspense fallback={waiting}>{children}</Suspense>;
}

/** How the agent has been doing: what it did, what that cost, and when it was at work. */
export function OverviewView() {
  return (
    <Page title="Overview" wide>
      <Reading waiting={<OverviewWaiting />}>
        <OverviewContent />
      </Reading>
    </Page>
  );
}

/** Who the agent is and what cannot be taken back, opened from the agent picker. */
export function AgentSettingsView({ profileId }: { profileId: string }) {
  return (
    <Page title="Agent settings">
      <AgentSettingsContent profileId={profileId} />
    </Page>
  );
}

/** The agent's schedules: what it does on its own, and when. */
export function SchedulesView() {
  return (
    <Page title="Schedules">
      <Reading waiting={<SchedulesWaiting />}>
        <SchedulesContent />
      </Reading>
    </Page>
  );
}

/**
 * What makes the agent its own beyond who it is, a tab at a time: the skills it can use, what it
 * remembers and, on a server, the channels it is reached on.
 */
export function CustomizeView({ profileId, tab }: { profileId: string; tab: CustomizeTab }) {
  const router = useRouter();
  const server = useGatewayMode() === 'server';
  // Channels are a server's alone; on this computer's gateway the address falls back to Skills.
  const shown = tab === 'channels' && !server ? 'skills' : tab;

  return (
    <Page title="Customize">
      <Segmented
        label="Customize"
        value={shown}
        onChange={(next) => router.replace(customizePath(profileId, next))}
        options={[
          { value: 'skills', label: 'Skills' },
          { value: 'memories', label: 'Memories' },
          ...(server ? [{ value: 'channels' as const, label: 'Channels' }] : []),
        ]}
      />
      {shown === 'skills' ? (
        <Reading key={shown} waiting={<SkillsWaiting />}>
          <SkillsPage />
        </Reading>
      ) : shown === 'memories' ? (
        <Reading key={shown} waiting={<MemoriesWaiting />}>
          <MemoriesPage />
        </Reading>
      ) : (
        <Reading key={shown} waiting={<ChannelsWaiting />}>
          <ChannelsPage />
        </Reading>
      )}
    </Page>
  );
}
