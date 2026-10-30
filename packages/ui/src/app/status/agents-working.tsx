'use client';

import { Menu } from '@base-ui/react/menu';
import { useQuery } from '@tanstack/react-query';
import { menuPopup } from '../../kit/menu';
import type { Run } from '../../lib/api';
import { conversationName } from '../../lib/conversation-name';
import { agentPath } from '../../lib/navigation';
import { queries, useProfiles } from '../../lib/query/profile';
import { useProfileId } from '../../lib/workspace';
import { useRouter } from '../../platform/navigation';
import { statusItem } from './status-item';

/** A chat the agent is at work in, and whether it waits on the owner there. */
type Working = { sessionId: string; name: string; waiting: boolean };

const live = new Set<Run['status']>(['queued', 'running', 'waiting']);

/**
 * The open agent's chats where something is under way, from anywhere in the app: one by its
 * name, several by their number, with a list to choose from. A chat waiting on the owner — an
 * approval, a question — says so first, as it goes no further without them. Nothing is shown
 * while the agent rests.
 */
export function AgentsWorking() {
  const profileId = useProfileId();
  const router = useRouter();
  const enabled = Boolean(profileId);
  const id = profileId ?? '';
  const activities = useQuery({ ...queries.activities(id), enabled }).data;
  const sessions = useQuery({ ...queries.sessions(id), enabled }).data;
  const projects = useQuery({ ...queries.projects(id), enabled }).data ?? [];
  const contacts = useQuery({ ...queries.contacts(id), enabled }).data ?? [];
  const profiles = useProfiles().data ?? [];

  const working = new Map<string, Working>();
  // A subagent's run is its parent's work: the parent's chat already stands for it.
  for (const run of activities ?? []) {
    if (!live.has(run.status) || run.subagent) continue;
    const session = sessions?.find((item) => item.id === run.sessionId);
    const name = session ? conversationName(session, { projects, contacts, profiles }) : 'A chat';
    const waiting = run.status === 'waiting' || Boolean(working.get(run.sessionId)?.waiting);
    working.set(run.sessionId, { sessionId: run.sessionId, name, waiting });
  }
  const chats = [...working.values()].sort((a, b) => Number(b.waiting) - Number(a.waiting));
  const first = chats[0];
  if (!profileId || !first) return null;

  const open = (chat: Working) =>
    router.push(agentPath(profileId, `sessions/${encodeURIComponent(chat.sessionId)}`));
  const waiting = chats.filter((chat) => chat.waiting).length;
  const said =
    chats.length === 1
      ? `${first.waiting ? 'Waiting for you' : 'Working'} · ${first.name}`
      : waiting
        ? `${waiting} waiting for you · ${chats.length} at work`
        : `Working in ${chats.length} chats`;
  const mark = <Pulse tone={waiting ? 'warn' : 'live'} />;

  if (chats.length === 1) {
    return (
      <button type="button" className={statusItem} onClick={() => open(first)} title={said}>
        {mark}
        <span className="max-w-64 truncate">{said}</span>
      </button>
    );
  }

  return (
    <Menu.Root>
      <Menu.Trigger className={statusItem} title={said}>
        {mark}
        <span className="truncate">{said}</span>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner side="top" align="start" sideOffset={6} className="z-50">
          <Menu.Popup className={`${menuPopup} max-w-80`}>
            {chats.map((chat) => (
              <Menu.Item
                key={chat.sessionId}
                onClick={() => open(chat)}
                className="flex h-8 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 outline-none select-none data-highlighted:bg-glass-press"
              >
                <Pulse tone={chat.waiting ? 'warn' : 'live'} />
                <span className="min-w-0 flex-1 truncate">{chat.name}</span>
                {chat.waiting && <span className="shrink-0 text-xs text-warn">Waiting</span>}
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** A small dot breathing while work goes on; amber when it waits on the owner. */
export function Pulse({ tone }: { tone: 'live' | 'warn' | 'bad' }) {
  const colour = { live: 'bg-good', warn: 'bg-warn', bad: 'bg-bad' }[tone];
  return (
    <span aria-hidden="true" className="relative grid size-2 shrink-0 place-items-center">
      <span
        className={`absolute inset-0 rounded-full ${colour} opacity-60 motion-safe:animate-ping`}
      />
      <span className={`relative size-2 rounded-full ${colour}`} />
    </span>
  );
}
