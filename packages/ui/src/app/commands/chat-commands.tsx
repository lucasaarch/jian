'use client';

import { GATEWAY_SESSION_CHANNEL } from '@jian/contracts';
import { History, Pencil, Pin, PinOff, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { conversationName } from '../../lib/conversation-name';
import { useAgents, useContacts, useProjects, useSessions } from '../../lib/query/agent';
import { useReconnect } from '../../lib/stores/reconnect';
import { useParams } from '../../platform/navigation';
import { useChatActions } from '../chat-actions';
import { DeleteChatDialog, RenameDialog } from '../chat-row';
import { type AppCommand, useCommands } from './registry';

/** What can be done to the chat open: the same as from its row, asking the same before deleting. */
export function ChatCommands({ profileId }: { profileId: string }) {
  const sessions = useSessions();
  const projects = useProjects();
  const contacts = useContacts();
  const profiles = useAgents();
  const actions = useChatActions(profileId);
  const { sessionId } = useParams<{ sessionId?: string }>();
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const session = sessionId ? sessions.find((item) => item.id === sessionId) : undefined;
  const name = session ? conversationName(session, { projects, contacts, profiles }) : '';
  // A contact's or another agent's chat goes by their name, which is not the chat's to change.
  const renames = session?.channel === GATEWAY_SESSION_CHANNEL;

  // biome-ignore lint/correctness/useExhaustiveDependencies: the actions read only what they are given when run.
  const commands = useMemo<AppCommand[]>(
    () =>
      session
        ? [
            {
              id: 'reload-chat',
              group: 'Chats',
              title: 'Reload chat',
              detail: name,
              keywords: ['conversation', 'history', 'messages', 'refresh', 'stuck'],
              icon: <History size={15} />,
              run: () => useReconnect.getState().reloadChat(),
            },
            {
              id: 'pin-chat',
              group: 'Chats',
              title: session.pinned ? 'Unpin chat' : 'Pin chat',
              detail: name,
              keywords: ['conversation', 'favorite', 'top'],
              icon: session.pinned ? <PinOff size={15} /> : <Pin size={15} />,
              run: () => actions.pin(session),
            },
            ...(renames
              ? [
                  {
                    id: 'rename-chat',
                    group: 'Chats' as const,
                    title: 'Rename chat',
                    detail: name,
                    keywords: ['conversation', 'title', 'name'],
                    icon: <Pencil size={15} />,
                    run: () => setRenaming(true),
                  },
                ]
              : []),
            {
              id: 'delete-chat',
              group: 'Chats',
              title: 'Delete chat',
              detail: name,
              danger: true,
              keywords: ['conversation', 'remove', 'trash'],
              icon: <Trash2 size={15} />,
              run: () => setDeleting(true),
            },
          ]
        : [],
    [session, name, renames],
  );
  useCommands('chat', commands);

  if (!session) return null;

  return (
    <>
      {renames && (
        <RenameDialog
          open={renaming}
          onOpenChange={setRenaming}
          name={name}
          rename={(title) => actions.rename(session, title)}
        />
      )}
      <DeleteChatDialog
        open={deleting}
        onOpenChange={setDeleting}
        name={name}
        remove={() => actions.remove(session)}
      />
    </>
  );
}
