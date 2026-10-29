'use client';

import Link from 'next/link';
import { type ReactNode, Suspense, useEffect } from 'react';
import { Loading, NoAgents } from '@/components/shell/states';
import { Empty } from '@/components/ui';
import { useProfiles } from '@/lib/query/profile';
import { useEventStream } from '@/lib/query/stream';
import { useLastProfile } from '@/lib/stores/last-profile';
import { useProfileId } from '@/lib/workspace';

/**
 * Everything under `/agents/:id` belongs to that agent: this is where its event stream runs, and
 * the one gate a page passes — the agent exists. What else a page shows it reads itself.
 */
export default function AgentLayout({ children }: { children: ReactNode }) {
  const profileId = useProfileId() ?? '';
  const profiles = useProfiles().data ?? [];
  const known = profiles.some((profile) => profile.id === profileId);

  if (!profiles.length) return <NoAgents />;

  if (!known) {
    return (
      <Empty
        title="This agent is not here"
        action={
          <Link href="/" className="button secondary">
            Open another agent
          </Link>
        }
      >
        It was deleted, or the link points to another gateway.
      </Empty>
    );
  }

  return <OpenAgent profileId={profileId}>{children}</OpenAgent>;
}

function OpenAgent({ profileId, children }: { profileId: string; children: ReactNode }) {
  const remember = useLastProfile((state) => state.remember);

  useEventStream(profileId);
  useEffect(() => remember(profileId), [profileId, remember]);

  // Keyed by the agent, so switching agents enters the page again instead of morphing it. Each
  // page waits for the slices it reads; a failed one lands on error.tsx beside this layout.
  return (
    <div key={profileId} className="page-enter">
      <Suspense fallback={<Loading />}>{children}</Suspense>
    </div>
  );
}
