'use client';

import { useQuery } from '@tanstack/react-query';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { agentPath } from '@/lib/navigation';
import { enablePush, pushOnHere } from '@/lib/push';
import { queries } from '@/lib/query/profile';
import { unread } from '@/lib/unread';
import { plainText } from '../ui/markdown';

/**
 * A notice, wherever the owner is in the panel, when the agent writes in a chat they are not
 * reading. One per chat at a time: a newer word replaces the notice already showing. A device
 * with notifications on gets them from its system instead, never both.
 */
export function ChatNotices({ profileId }: { profileId: string }) {
  const { data: sessions } = useQuery(queries.sessions(profileId));
  const pathname = usePathname();
  const router = useRouter();
  // The last word known in each conversation; the first read of the list only learns them.
  const known = useRef<Map<string, string>>(undefined);

  // Notifications are on unless the owner says no: asked with their first tap in the panel.
  useEffect(() => enablePush(), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Only a new list of conversations is news.
  useEffect(() => {
    if (!sessions) return;
    const first = !known.current;
    const seen = known.current ?? new Map<string, string>();

    for (const session of sessions) {
      const at = session.lastMessage?.at;
      if (!at) continue;
      const before = seen.get(session.id);
      seen.set(session.id, at);
      if (first || before === at || !unread(session) || pushOnHere()) continue;
      const path = agentPath(profileId, `sessions/${encodeURIComponent(session.id)}`);
      if (pathname === path) continue;

      toast(session.title ?? 'New chat', {
        id: `chat:${session.id}`,
        description: plainText(session.lastMessage?.text ?? '').slice(0, 140),
        action: { label: 'Open', onClick: () => router.push(path) },
      });
    }
    known.current = seen;
  }, [sessions]);

  return null;
}
