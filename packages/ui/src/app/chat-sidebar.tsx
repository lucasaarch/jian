'use client';

import { GATEWAY_SESSION_CHANNEL } from '@jian/contracts';
import {
  AlarmClock,
  Blocks,
  Bot,
  LayoutDashboard,
  MessageSquare,
  SquarePen,
  Terminal,
} from 'lucide-react';
import { type ReactNode, Suspense, useEffect, useRef } from 'react';
import { TelegramLogo, WhatsAppLogo } from '../components/ui';
import type { Session } from '../lib/api';
import { conversationName } from '../lib/conversation-name';
import { agentPath, newChatPath } from '../lib/navigation';
import { usePhone } from '../lib/phone';
import {
  useActivities,
  useAgents,
  useChannels,
  useContacts,
  useProjects,
  useSessions,
} from '../lib/query/agent';
import {
  MAX_SIDEBAR_WIDTH,
  MIN_CHAT_WIDTH,
  MIN_SIDEBAR_WIDTH,
  useLayout,
} from '../lib/stores/layout';
import { unread } from '../lib/unread';
import { useActions, useDeleteConversation, useRefresh } from '../lib/workspace';
import { useParams, usePathname, useRouter } from '../platform/navigation';
import { agentPlace, customizePath, customizeTabs, schedulesPath } from './agent-pages';
import { ChatRow } from './chat-row';
import { ChatSection, ProjectFolder } from './chat-section';
import { channelKind, chatSections, lastAt } from './chat-sections';
import { SidebarSkeleton } from './chats-loading';

/** What a conversation is at a glance: the app's own chat, or the channel it came through. */
function conversationIcon(session: Session) {
  if (session.channel === GATEWAY_SESSION_CHANNEL) return <MessageSquare size={14} />;
  const kind = channelKind(session.channel);
  if (kind === 'whatsapp') return <WhatsAppLogo size={13} />;
  if (kind === 'telegram') return <TelegramLogo size={13} />;
  if (kind === 'agents') return <Bot size={14} />;
  return <Terminal size={14} />;
}

/**
 * The chats of the agent in use, down the window's side: a new chat at the top, then Projects,
 * a folder for each, the chats in none, and each channel the agent is reached on. Put away, it
 * leaves the conversation the whole width; `data-chat-sidebar` tells the bar above it so.
 */
/**
 * The sidebar's edge, to drag or to move with the arrow keys; a double click gives back the
 * default. It stops where the chat, with the Inspector beside it, would lose its minimum.
 */
function SidebarResizer() {
  const chosen = useLayout((state) => state.sidebarWidth);
  const setWidth = useLayout((state) => state.setSidebarWidth);
  const drag = useRef<{ x: number; width: number } | null>(null);
  const edge = useRef<HTMLHRElement>(null);
  useEffect(() => {
    const root = document.documentElement;
    if (chosen === null) root.style.removeProperty('--sidebar-chosen');
    else root.style.setProperty('--sidebar-chosen', `${chosen}px`);
  }, [chosen]);
  const current = () => edge.current?.parentElement?.getBoundingClientRect().width ?? 256;
  const resize = (next: number) => {
    const inspector = document.querySelector<HTMLElement>('[data-inspector-host]:not([data-full])');
    const room = window.innerWidth - (inspector?.offsetWidth ?? 0) - MIN_CHAT_WIDTH;
    const limit = Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, room));
    setWidth(Math.round(Math.max(MIN_SIDEBAR_WIDTH, Math.min(next, limit))));
  };
  const finish = () => {
    drag.current = null;
  };
  return (
    <hr
      ref={edge}
      aria-label="Resize sidebar"
      aria-orientation="vertical"
      aria-valuemin={MIN_SIDEBAR_WIDTH}
      aria-valuemax={MAX_SIDEBAR_WIDTH}
      aria-valuenow={Math.round(chosen ?? 256)}
      tabIndex={0}
      className="absolute inset-y-0 -right-1 z-30 m-0 h-full w-2 cursor-col-resize touch-none border-0 bg-transparent focus-visible:outline focus-visible:outline-1 focus-visible:outline-ink/20"
      onDoubleClick={() => setWidth(null)}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault();
          resize(current() + (event.key === 'ArrowRight' ? 16 : -16));
        }
      }}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, width: current() };
      }}
      onPointerMove={(event) => {
        if (drag.current) resize(drag.current.width + event.clientX - drag.current.x);
      }}
      onPointerUp={finish}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
    />
  );
}

export function ChatSidebar({
  profileId,
  loading = false,
  footer,
}: {
  profileId?: string;
  /** What sits at its foot whatever it lists: the agent in use. */
  footer?: ReactNode;
  /** No agent is open yet, though one is coming: the sections' shape stands in for them. */
  loading?: boolean;
}) {
  const phone = usePhone();
  // A phone has no room beside the sidebar to put it away for: it is the list there.
  const collapsed = useLayout((state) => state.chatList) && !phone;
  if (collapsed) return null;

  return (
    <nav
      data-chat-sidebar
      aria-label="Chats"
      // A host that draws its title bar over the window's top keeps `--chrome-top` clear here.
      // On a phone it is the screen itself, until something it lists is opened.
      className="relative flex h-full w-(--sidebar-width) shrink-0 flex-col border-r border-line bg-sidebar pt-(--chrome-top) phone:w-full phone:border-r-0 phone:bg-canvas phone:pb-[env(safe-area-inset-bottom)]"
    >
      {profileId ? (
        <Suspense
          fallback={
            <>
              <NewChat />
              <SidebarSkeleton />
            </>
          }
        >
          <AgentSidebar profileId={profileId} />
        </Suspense>
      ) : (
        <>
          <NewChat />
          {loading && <SidebarSkeleton />}
        </>
      )}
      <div className="mt-auto">{footer}</div>
      {!phone && <SidebarResizer />}
    </nav>
  );
}

const action =
  'flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-[13px] text-ink transition-colors hover:bg-glass-hover aria-[current=page]:bg-glass-press disabled:opacity-50 phone:h-10 phone:text-sm phone:aria-[current=page]:bg-transparent';

/**
 * The top of the sidebar: a new chat — an action, never shown as the one open — and the agent's
 * places besides its chats, Overview, Schedules and Customize, marked while open. Customize
 * counts the contacts waiting for approval, and opens on its Channels then, where they wait.
 */
function NewChat({ profileId, pending = 0 }: { profileId?: string; pending?: number }) {
  const router = useRouter();
  const place = agentPlace(usePathname());
  const go = (path: string) => () => router.push(path);
  return (
    <div className="grid gap-px px-2 pt-2 pb-5">
      <button
        type="button"
        onClick={profileId ? go(newChatPath(profileId)) : undefined}
        disabled={!profileId}
        className={action}
      >
        <SquarePen size={15} className="text-muted" aria-hidden="true" />
        New chat
      </button>
      <button
        type="button"
        onClick={profileId ? go(agentPath(profileId)) : undefined}
        disabled={!profileId}
        aria-current={place === 'overview' ? 'page' : undefined}
        className={action}
      >
        <LayoutDashboard size={15} className="text-muted" aria-hidden="true" />
        Overview
      </button>
      <button
        type="button"
        onClick={profileId ? go(schedulesPath(profileId)) : undefined}
        disabled={!profileId}
        aria-current={place === 'schedules' ? 'page' : undefined}
        className={action}
      >
        <AlarmClock size={15} className="text-muted" aria-hidden="true" />
        Schedules
      </button>
      <button
        type="button"
        onClick={
          profileId ? go(customizePath(profileId, pending > 0 ? 'channels' : 'skills')) : undefined
        }
        disabled={!profileId}
        aria-current={place && customizeTabs.includes(place) ? 'page' : undefined}
        className={action}
      >
        <Blocks size={15} className="text-muted" aria-hidden="true" />
        Customize
        {pending > 0 && (
          <span className="ml-auto grid h-4.5 min-w-4.5 place-items-center rounded-full bg-ink px-1 text-[11px] font-semibold text-canvas tabular-nums">
            {pending}
            <span className="sr-only"> waiting for approval</span>
          </span>
        )}
      </button>
    </div>
  );
}

function AgentSidebar({ profileId }: { profileId: string }) {
  const sessions = useSessions();
  const projects = useProjects();
  const channels = useChannels();
  const contacts = useContacts();
  const profiles = useAgents();
  const activities = useActivities();
  const router = useRouter();
  const { api, mutate } = useActions();
  const refresh = useRefresh();
  const deleteConversation = useDeleteConversation();
  const { sessionId: selected } = useParams<{ sessionId?: string }>();

  const parents = new Map(activities.map((run) => [run.id, run]));
  const working = new Set(
    activities
      .filter((run) => run.status === 'queued' || run.status === 'running')
      .map((run) =>
        run.subagent
          ? (parents.get(run.subagent.parentRunId)?.sessionId ?? run.sessionId)
          : run.sessionId,
      ),
  );
  const open = (id: string) =>
    router.push(agentPath(profileId, `sessions/${encodeURIComponent(id)}`));

  const row = (session: Session, inProject: boolean) => (
    <ChatRow
      key={session.id}
      // Under its project's heading, a chat not yet named is only a new chat.
      name={conversationName(session, {
        projects: inProject ? [] : projects,
        contacts,
        profiles,
      })}
      {...(inProject ? {} : { icon: conversationIcon(session) })}
      pinned={session.pinned}
      pin={() =>
        void mutate(() => api.setSessionPin(profileId, session.id, !session.pinned)).then(
          (saved) => {
            if (saved) return refresh();
          },
        )
      }
      at={lastAt(session)}
      selected={session.id === selected}
      unread={unread(session)}
      working={working.has(session.id)}
      open={() => open(session.id)}
      {...(session.channel === GATEWAY_SESSION_CHANNEL
        ? {
            rename: async (title: string) => {
              const saved = await mutate(() => api.renameSession(profileId, session.id, title));
              if (saved) await refresh();
              return Boolean(saved);
            },
          }
        : {})}
      remove={() =>
        void deleteConversation(session.id).then((deleted) => {
          if (deleted && session.id === selected) router.replace(agentPath(profileId, 'sessions'));
        })
      }
    />
  );

  return (
    <>
      <NewChat
        profileId={profileId}
        pending={contacts.filter((contact) => contact.status === 'pending').length}
      />
      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-2 pb-4">
        {chatSections({ sessions, projects, channels }).map((section) =>
          section.kind === 'projects' ? (
            <ChatSection key={section.id} id={section.id} name={section.name}>
              {section.folders.map(({ project, sessions }) => (
                <ProjectFolder
                  key={project.id}
                  id={project.id}
                  name={project.name}
                  rows={sessions.map((session) => row(session, true))}
                  newChat={{
                    label: `New chat in ${project.name}`,
                    start: () => router.push(newChatPath(profileId, project.id)),
                  }}
                />
              ))}
            </ChatSection>
          ) : (
            <ChatSection
              key={section.id}
              id={section.id}
              name={section.name}
              {...(section.kind === 'conversations' ? { empty: 'No chats yet' } : {})}
            >
              {section.sessions.map((session) => row(session, false))}
            </ChatSection>
          ),
        )}
      </div>
    </>
  );
}
