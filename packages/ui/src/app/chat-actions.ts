'use client';

import { GATEWAY_SESSION_CHANNEL } from '@jian/contracts';
import type { Contact, Session } from '../lib/api';
import { renamedContact } from '../lib/conversation-name';
import { agentPath } from '../lib/navigation';
import { useActions, useDeleteConversation, useRefresh } from '../lib/workspace';
import { useParams, useRouter } from '../platform/navigation';
import type { Renaming } from './chat-row';

/** What is done to a chat from its row and from the palette alike. */
export function useChatActions(profileId: string) {
  const { api, mutate } = useActions();
  const refresh = useRefresh();
  const deleteConversation = useDeleteConversation();
  const router = useRouter();
  const { sessionId: open } = useParams<{ sessionId?: string }>();

  const saved = async (write: () => Promise<unknown>) => {
    const done = await mutate(write);
    if (done) await refresh();
    return done;
  };

  return {
    pin: (session: Session) =>
      void mutate(() => api.setSessionPin(profileId, session.id, !session.pinned)).then((saved) => {
        if (saved) return refresh();
      }),
    /**
     * Absent where the name is not the conversation's to change: a group's, another agent's, an
     * email address's. A person's conversation goes by their name, so renaming it renames them.
     */
    renaming: (session: Session, contacts: Contact[]): Renaming | undefined => {
      if (session.channel === GATEWAY_SESSION_CHANNEL) {
        return {
          what: 'chat',
          maxLength: 160,
          rename: (title) => saved(() => api.renameSession(profileId, session.id, title)),
        };
      }
      const contact = renamedContact(session, contacts);
      if (!contact) return undefined;
      return {
        what: 'contact',
        maxLength: 100,
        rename: (title) =>
          saved(() => api.updateContact(profileId, contact.id, { displayName: title })),
      };
    },
    /** Whether it was deleted. Deleting the one open leaves for the agent's chats. */
    remove: async (session: Session) => {
      const deleted = await deleteConversation(session.id);
      if (deleted && session.id === open) router.replace(agentPath(profileId, 'sessions'));
      return deleted;
    },
  };
}
