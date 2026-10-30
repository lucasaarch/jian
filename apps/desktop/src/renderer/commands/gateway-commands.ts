import { newChatPath, useProfileId, useRouter } from '@jian/ui';
import { MessageSquarePlus } from 'lucide-react';
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
          ]
        : [],
    [profileId, router],
  );
  useCommands('gateway', commands);
}
