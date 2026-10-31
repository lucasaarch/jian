'use client';

import type { Session } from '../lib/api';
import { agentPath } from '../lib/navigation';
import { useActions, useDeleteConversation, useRefresh } from '../lib/workspace';
import { useParams, useRouter } from '../platform/navigation';

/** What is done to a chat from its row and from the palette alike. */
export function useChatActions(profileId: string) {
  const { api, mutate } = useActions();
  const refresh = useRefresh();
  const deleteConversation = useDeleteConversation();
  const router = useRouter();
  const { sessionId: open } = useParams<{ sessionId?: string }>();

  return {
    pin: (session: Session) =>
      void mutate(() => api.setSessionPin(profileId, session.id, !session.pinned)).then((saved) => {
        if (saved) return refresh();
      }),
    /** Whether the name was saved. */
    rename: async (session: Session, title: string) => {
      const saved = await mutate(() => api.renameSession(profileId, session.id, title));
      if (saved) await refresh();
      return Boolean(saved);
    },
    /** Whether it was deleted. Deleting the one open leaves for the agent's chats. */
    remove: async (session: Session) => {
      const deleted = await deleteConversation(session.id);
      if (deleted && session.id === open) router.replace(agentPath(profileId, 'sessions'));
      return deleted;
    },
  };
}
