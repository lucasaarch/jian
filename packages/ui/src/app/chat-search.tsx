'use client';

import { MessageSquare } from 'lucide-react';
import { useMemo } from 'react';
import { type Command, CommandPalette } from '../kit';
import { conversationName } from '../lib/conversation-name';
import { ago } from '../lib/format';
import { agentPath } from '../lib/navigation';
import { useAgents, useChannels, useContacts, useProjects, useSessions } from '../lib/query/agent';
import { useChatSearch } from '../lib/stores/chat-search';
import { useRouter } from '../platform/navigation';
import { chatSections, lastAt } from './chat-sections';

const labels = {
  title: 'Search chats',
  search: 'Search chats',
  placeholder: 'Search chats',
  empty: 'No chat matches.',
};

/**
 * Every conversation of the agent in use, found by its name or by what was said in it last;
 * beside each, the section it is listed in and how long ago it was spoken in.
 */
export function ChatSearch({ profileId }: { profileId: string }) {
  const { open, setOpen } = useChatSearch();
  const sessions = useSessions();
  const projects = useProjects();
  const channels = useChannels();
  const contacts = useContacts();
  const profiles = useAgents();
  const router = useRouter();

  const chats = useMemo<Command[]>(
    () =>
      chatSections({ sessions, projects, channels })
        // Beside each chat, where the sidebar lists it: its project, or its section.
        .flatMap((section) =>
          section.kind === 'projects'
            ? section.folders.flatMap((folder) =>
                folder.sessions.map((session) => ({ session, where: folder.project.name })),
              )
            : section.sessions.map((session) => ({ session, where: section.name })),
        )
        .sort((a, b) => lastAt(b.session).localeCompare(lastAt(a.session)))
        .map(({ session, where }) => ({
          id: session.id,
          title: conversationName(session, { projects, contacts, profiles }),
          detail: `${where} · ${ago(lastAt(session))}`,
          keywords: [where, session.lastMessage?.text ?? ''],
          icon: <MessageSquare size={15} />,
          run: () =>
            router.push(agentPath(profileId, `sessions/${encodeURIComponent(session.id)}`)),
        })),
    [sessions, projects, channels, contacts, profiles, router, profileId],
  );

  return <CommandPalette open={open} onOpenChange={setOpen} commands={chats} labels={labels} />;
}
