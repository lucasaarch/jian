'use client';

import { Plus } from 'lucide-react';
import { useEffect } from 'react';
import { ChatNotices } from '../components/notifications/chat-notices';
import { Sessions } from '../components/sessions';
import { Spinner } from '../components/ui';
import { Action } from '../kit';
import { agentPath } from '../lib/navigation';
import { useProfiles } from '../lib/query/profile';
import { useEventStream } from '../lib/query/stream';
import { useLastProfile } from '../lib/stores/last-profile';
import { useActions, useProfileId } from '../lib/workspace';
import { useRouter } from '../platform/navigation';

/**
 * The desktop app's one screen: an agent's conversations, the list and the open one. Opened on
 * no agent, it goes to the last one used, or the first; with none, it offers to create one.
 */
export function ChatsApp({ createAgent }: { createAgent: () => void }) {
  const profiles = useProfiles().data;
  const profileId = useProfileId();
  const last = useLastProfile((state) => state.profileId);
  const router = useRouter();
  const known = profiles?.some((profile) => profile.id === profileId) ?? false;

  useEffect(() => {
    if (!profiles?.length || known) return;
    const next = profiles.find((profile) => profile.id === last) ?? profiles[0];
    if (next) router.replace(agentPath(next.id, 'sessions'));
  }, [profiles, known, last, router]);

  if (!profiles) {
    return (
      <main className="grid h-(--app-height) place-items-center" aria-busy="true">
        <Spinner size={28} />
      </main>
    );
  }

  if (!profiles.length) {
    return (
      <main className="grid h-(--app-height) place-items-center px-6">
        <section className="grid max-w-sm justify-items-center gap-3 text-center">
          <h1 className="text-xl font-semibold tracking-tight">Bring your first agent to life</h1>
          <p className="text-sm text-muted">
            A name and what it is for. Its model comes from a provider.
          </p>
          <Action tone="primary" onClick={createAgent} className="mt-2">
            <Plus size={16} />
            Create an agent
          </Action>
        </section>
      </main>
    );
  }

  return profileId && known ? <AgentChats key={profileId} profileId={profileId} /> : null;
}

function AgentChats({ profileId }: { profileId: string }) {
  const remember = useLastProfile((state) => state.remember);
  useEventStream(profileId);
  useEffect(() => remember(profileId), [profileId, remember]);

  return (
    <main className="h-(--app-height) overflow-hidden">
      <ChatNotices profileId={profileId} />
      <Sessions {...useActions()} />
    </main>
  );
}
