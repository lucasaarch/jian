'use client';

import { ChevronLeft, SquarePen } from 'lucide-react';
import { conversationName } from '../lib/conversation-name';
import { agentPath, newChatPath } from '../lib/navigation';
import { useAgents, useContacts, useProjects, useSessions } from '../lib/query/agent';
import { useParams, useRouter } from '../platform/navigation';
import type { AgentPlace } from './agent-pages';

const titles: Record<AgentPlace, string> = {
  overview: 'Overview',
  schedules: 'Schedules',
  settings: 'Agent settings',
  skills: 'Customize',
  memories: 'Customize',
  channels: 'Customize',
};

const button =
  'grid size-10 shrink-0 place-items-center rounded-full text-ink transition-colors active:bg-glass-press';

/**
 * A phone's bar over whatever the sidebar opened: back to the chats, what is open, and a new
 * chat. The browser's own back is gone in an app on the Home Screen, so this is the way out.
 */
export function PhoneBar({ profileId, place }: { profileId: string; place?: AgentPlace }) {
  const router = useRouter();
  const sessions = useSessions();
  const projects = useProjects();
  const contacts = useContacts();
  const profiles = useAgents();
  const { sessionId } = useParams<{ sessionId?: string }>();
  const session = sessionId ? sessions.find((item) => item.id === sessionId) : undefined;
  const title = place
    ? titles[place]
    : session
      ? conversationName(session, { projects, contacts, profiles })
      : 'New chat';

  return (
    <header className="glass-bar flex shrink-0 items-center gap-1 border-b border-line px-1.5 pt-[env(safe-area-inset-top)]">
      <div className="flex h-12 min-w-0 flex-1 items-center gap-1">
        <button
          type="button"
          className={button}
          aria-label="Chats"
          onClick={() => router.push(agentPath(profileId, 'sessions'))}
        >
          <ChevronLeft size={22} />
        </button>
        <span className="min-w-0 flex-1 truncate text-center text-[15px] font-semibold">
          {title}
        </span>
        <button
          type="button"
          className={button}
          aria-label="New chat"
          onClick={() => router.push(newChatPath(profileId))}
        >
          <SquarePen size={19} />
        </button>
      </div>
    </header>
  );
}
