'use client';

import { GATEWAY_SESSION_CHANNEL } from '@jian/contracts';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  AlarmClock,
  Blocks,
  Bot,
  GitPullRequest,
  Mail,
  MessageSquare,
  Shapes,
  SquarePen,
  Terminal,
} from 'lucide-react';
import { type ReactNode, Suspense, useEffect, useRef } from 'react';
import { choiceOfSession } from '../components/sessions/workspace-choice';
import { TelegramLogo, WhatsAppLogo } from '../components/ui';
import type { Session } from '../lib/api';
import { conversationName } from '../lib/conversation-name';
import { useGatewayMode } from '../lib/gateway-mode';
import {
  activityPath,
  agentPath,
  artifactsPath,
  newChatPath,
  onActivity,
  onArtifacts,
  onPlugins,
  onPulls,
  onSchedules,
  pluginsPath,
  pullsPath,
  schedulesPath,
} from '../lib/navigation';
import { usePhone } from '../lib/phone';
import {
  useActivities,
  useAgents,
  useChannels,
  useContacts,
  useProjects,
  useSessions,
} from '../lib/query/agent';
import { queries } from '../lib/query/profile';
import {
  MAX_SIDEBAR_WIDTH,
  MIN_CHAT_WIDTH,
  MIN_SIDEBAR_WIDTH,
  useLayout,
} from '../lib/stores/layout';
import { useWorkspaces } from '../lib/stores/workspace-choice';
import { useThisMachine } from '../lib/this-machine';
import { unread } from '../lib/unread';
import { useParams, usePathname, useRouter } from '../platform/navigation';
import { useChatActions } from './chat-actions';
import { ChatRow } from './chat-row';
import { ChatSection, WorkspaceFolder } from './chat-section';
import { channelKind, chatSections, lastAt, NO_PROJECT, workspaceName } from './chat-sections';
import { SidebarSkeleton } from './chats-loading';
import { WorktreeLoss } from './worktree-loss';

/** What a conversation is at a glance: the app's own chat, or the channel it came through. */
function conversationIcon(session: Session) {
  if (session.channel === GATEWAY_SESSION_CHANNEL) return <MessageSquare size={14} />;
  const kind = channelKind(session.channel);
  if (kind === 'whatsapp') return <WhatsAppLogo size={13} />;
  if (kind === 'telegram') return <TelegramLogo size={13} />;
  if (kind === 'email') return <Mail size={14} />;
  if (kind === 'agents') return <Bot size={14} />;
  return <Terminal size={14} />;
}

/**
 * The chats of the agent in use, down the window's side: a new chat at the top, then Recent, a
 * folder for each project and one for the chats on none, and each channel the agent is reached
 * on. Put away, it leaves the conversation the whole width; `data-chat-sidebar` tells the bar
 * above it so.
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
  // It mounts long after the window when a stage comes first, and the Inspector goes by its width.
  useEffect(() => {
    useLayout.getState().sidebarMoved();
    return () => useLayout.getState().sidebarMoved();
  }, []);
  if (collapsed) return null;

  return (
    <nav
      data-chat-sidebar
      aria-label="Chats"
      // A host that draws its title bar over the window's top keeps `--chrome-top` clear here.
      // On a phone it is the screen itself, until something it lists is opened.
      className="relative flex h-full w-(--sidebar-width) shrink-0 flex-col border-r border-line bg-sidebar pt-(--chrome-top) phone:w-full phone:border-r-0 phone:bg-canvas phone:pb-(--home-gap)"
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
  'flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-[13px] text-ink transition-colors hover:bg-glass-hover aria-[current=page]:bg-glass-press disabled:opacity-50';

/** A place on a phone: one of a row of them, its icon over its name. */
const tile =
  'flex h-13 min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-xl text-[11px] text-muted transition-colors active:bg-glass-press disabled:opacity-50';

/**
 * The top of the sidebar: a new chat — an action, never shown as the one open — and the agent's
 * Schedules, then every Artifact it made and the Plugins it can use, each in the chat's place. On
 * a server with GitHub connected, the pull requests, which take the chat's place too: GitHub can
 * only reach a gateway with a public address. Its Activity, also in the chat's place, is always
 * last. On a phone the places are one row, so the chats get the screen; a new chat is in the
 * bar above (web-app.tsx), where every phone screen keeps it (phone-bar.tsx).
 */
function NewChat({ profileId }: { profileId?: string }) {
  const router = useRouter();
  const phone = usePhone();
  const server = useGatewayMode() === 'server';
  const github = useQuery({ ...queries.githubIntegration(), enabled: server });
  const pulls = server && Boolean(github.data?.accounts.length);
  const pathname = usePathname();
  const places = [
    { name: 'Schedules', icon: AlarmClock, path: schedulesPath, on: onSchedules },
    { name: 'Artifacts', icon: Shapes, path: artifactsPath, on: onArtifacts },
    { name: 'Plugins', icon: Blocks, path: pluginsPath, on: onPlugins },
    ...(pulls && profileId
      ? [
          {
            name: 'Pull requests',
            short: 'PRs',
            icon: GitPullRequest,
            path: pullsPath,
            on: onPulls,
          },
        ]
      : []),
    { name: 'Activity', icon: Activity, path: activityPath, on: onActivity },
  ];
  const go = (path: (id: string) => string) =>
    profileId ? () => router.push(path(profileId)) : undefined;

  if (phone)
    return (
      <div className="flex gap-1 px-2 pt-1 pb-3">
        {places.map(({ name, short, icon: Icon, path }) => (
          <button
            key={name}
            type="button"
            onClick={go(path)}
            disabled={!profileId}
            aria-label={short ? name : undefined}
            className={tile}
          >
            <Icon size={18} aria-hidden="true" />
            <span className="max-w-full truncate">{short ?? name}</span>
          </button>
        ))}
      </div>
    );

  return (
    <div className="grid gap-px px-2 pt-2 pb-5">
      <button type="button" onClick={go(newChatPath)} disabled={!profileId} className={action}>
        <SquarePen size={15} className="text-muted" aria-hidden="true" />
        New chat
      </button>
      {places.map(({ name, icon: Icon, path, on }) => (
        <button
          key={name}
          type="button"
          onClick={go(path)}
          disabled={!profileId}
          aria-current={on(pathname) ? 'page' : undefined}
          className={action}
        >
          <Icon size={15} className="text-muted" aria-hidden="true" />
          {name}
        </button>
      ))}
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
  const actions = useChatActions(profileId);
  const { sessionId: selected } = useParams<{ sessionId?: string }>();
  const machine = useThisMachine();
  const server = useGatewayMode() !== 'local';
  const startOn = useWorkspaces((state) => state.startOn);
  // A chat on a project, worked on anywhere but here. One on nothing in particular says nothing.
  const isRemote = (session: Session) =>
    server &&
    Boolean(workspaceName(session, projects)) &&
    session.remoteMachineId !== machine?.machineId;

  const parents = new Map(activities.map((run) => [run.id, run]));
  // A subagent's turn is told in the chat that handed it the work: its own session is hidden.
  const chatOf = (run: (typeof activities)[number]) =>
    run.subagent
      ? (parents.get(run.subagent.parentRunId)?.sessionId ?? run.sessionId)
      : run.sessionId;
  const working = new Set(
    activities.filter((run) => run.status === 'queued' || run.status === 'running').map(chatOf),
  );
  // Stopped for an approval or an answer, until the owner gives it.
  const waiting = new Set(activities.filter((run) => run.status === 'waiting').map(chatOf));
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
      {...(inProject ? { nested: true } : { icon: conversationIcon(session) })}
      pinned={session.pinned}
      remote={isRemote(session)}
      pin={() => actions.pin(session)}
      at={lastAt(session)}
      selected={session.id === selected}
      unread={unread(session)}
      working={working.has(session.id)}
      waiting={waiting.has(session.id)}
      open={() => open(session.id)}
      renaming={actions.renaming(session, contacts)}
      remove={() => actions.remove(session)}
      loss={<WorktreeLoss profileId={profileId} sessionId={session.id} />}
    />
  );

  return (
    <>
      <NewChat profileId={profileId} />
      <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto px-2 pb-4">
        {chatSections({ sessions, projects, channels }).map((section) =>
          section.kind === 'recent' ? (
            <ChatSection key={section.id} id={section.id} name={section.name} empty="No chats yet">
              {section.folders.map((folder) => (
                <WorkspaceFolder
                  key={folder.id}
                  id={folder.id}
                  name={folder.name}
                  rows={folder.sessions.map((session) => row(session, true))}
                  newChat={{
                    label:
                      folder.id === NO_PROJECT
                        ? 'New chat with no project'
                        : `New chat in ${folder.name}`,
                    start: () => {
                      startOn(choiceOfSession(folder.sessions[0] as Session, projects, machine));
                      router.push(newChatPath(profileId));
                    },
                  }}
                />
              ))}
            </ChatSection>
          ) : (
            <ChatSection key={section.id} id={section.id} name={section.name}>
              {section.sessions.map((session) => row(session, false))}
            </ChatSection>
          ),
        )}
      </div>
    </>
  );
}
