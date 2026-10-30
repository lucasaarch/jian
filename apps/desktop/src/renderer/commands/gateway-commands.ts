import { agentSettingsPath, newChatPath, searchChats, useProfileId, useRouter } from '@jian/ui';
import { MessageSquarePlus, Search, UserCog } from 'lucide-react';
import { createElement, useMemo } from 'react';
import { type AppCommand, useCommands } from './registry';

/** The commands of the gateway open in the window: they act on its agent. */
export function useGatewayCommands(): void {
  const profileId = useProfileId();
  const router = useRouter();
  const commands = useMemo<AppCommand[]>(
    () =>
      profileId
        ? [
            {
              id: 'new-chat',
              title: 'New chat',
              keywords: ['conversation', 'start', 'compose'],
              icon: createElement(MessageSquarePlus, { size: 15 }),
              keys: { key: 'n' },
              run: () => router.push(newChatPath(profileId)),
            },
            {
              id: 'search-chats',
              title: 'Search chats',
              keywords: ['find', 'conversation', 'go to'],
              icon: createElement(Search, { size: 15 }),
              keys: { key: 'k' },
              run: searchChats,
            },
            {
              id: 'agent-settings',
              title: 'Agent settings',
              keywords: ['identity', 'name', 'instructions', 'reset', 'delete', 'agent'],
              icon: createElement(UserCog, { size: 15 }),
              run: () => router.push(agentSettingsPath(profileId)),
            },
          ]
        : [],
    [profileId, router],
  );
  useCommands('gateway', commands);
}
