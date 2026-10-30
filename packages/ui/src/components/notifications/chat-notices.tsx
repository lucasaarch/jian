'use client';

import { GATEWAY_SESSION_CHANNEL } from '@jian/contracts';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import type { Session } from '../../lib/api';
import { agentPath } from '../../lib/navigation';
import { enablePush, hostNotifies, pushOnHere } from '../../lib/push';
import { queries } from '../../lib/query/profile';
import { worthNotice } from '../../lib/unread';
import { usePathname, useRouter } from '../../platform/navigation';
import { plainText } from '../ui/markdown';

/**
 * A notice, wherever the owner is in the panel, when something happens in a conversation they
 * are not reading: the agent replies or asks for them, or someone writes to it. One per chat at a
 * time: a newer word replaces the notice already showing. What the device's system shows instead
 * is never told twice: Web Push carries the panel's chats, and a native host shows every one.
 */
export function ChatNotices({ profileId }: { profileId: string }) {
  const { data: sessions } = useQuery(queries.sessions(profileId));
  const { data: runs } = useQuery(queries.activities(profileId));
  const pathname = usePathname();
  const router = useRouter();
  // The last word known in each conversation, and what waits on the owner; each first read only
  // learns them.
  const known = useRef<Map<string, string>>(undefined);
  const asking = useRef<Set<string>>(undefined);

  // Notifications are on unless the owner says no: asked with their first tap in the panel.
  useEffect(() => enablePush(), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: Only new lists of conversations and runs are news.
  useEffect(() => {
    if (!sessions) return;
    const chatPath = (id: string) => agentPath(profileId, `sessions/${encodeURIComponent(id)}`);
    const quiet = (session: Session | undefined, id: string) =>
      hostNotifies() ||
      pathname === chatPath(id) ||
      (pushOnHere() && session?.channel === GATEWAY_SESSION_CHANNEL);
    const tell = (id: string, session: Session | undefined, description: string) =>
      toast(session?.title ?? 'New chat', {
        id: `chat:${id}`,
        description,
        action: { label: 'Open', onClick: () => router.push(chatPath(id)) },
      });

    const firstSaid = !known.current;
    const said = known.current ?? new Map<string, string>();
    for (const session of sessions) {
      const at = session.lastMessage?.at;
      if (!at) continue;
      const before = said.get(session.id);
      said.set(session.id, at);
      if (firstSaid || before === at || !worthNotice(session) || quiet(session, session.id)) {
        continue;
      }
      tell(session.id, session, plainText(session.lastMessage?.text ?? '').slice(0, 140));
    }
    known.current = said;

    if (!runs) return;
    const firstAsked = !asking.current;
    const waiting = new Set<string>();
    for (const run of runs) {
      const what =
        run.status === 'waiting' && !run.subagent ? (run.approval ?? run.question) : undefined;
      if (!what) continue;
      const key = `${run.id}/${what.id}`;
      waiting.add(key);
      if (firstAsked || asking.current?.has(key)) continue;
      const session = sessions.find((item) => item.id === run.sessionId);
      if (quiet(session, run.sessionId)) continue;
      tell(
        run.sessionId,
        session,
        run.approval
          ? `Waiting for your approval: ${run.approval.title}`
          : `Asks: ${run.question?.prompt ?? ''}`.slice(0, 140),
      );
    }
    asking.current = waiting;
  }, [sessions, runs]);

  return null;
}
