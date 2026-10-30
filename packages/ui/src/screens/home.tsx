'use client';

import { useEffect } from 'react';
import { Loading, NoAgents } from '../components/shell/states';
import { agentPath } from '../lib/navigation';
import { useProfiles } from '../lib/query/profile';
import { useLastProfile } from '../lib/stores/last-profile';
import { useRouter } from '../platform/navigation';

/** `/` belongs to no agent: it opens the one the owner had open last, or the first. */
export function Home() {
  const router = useRouter();
  const profiles = useProfiles().data ?? [];
  const last = useLastProfile((state) => state.profileId);
  const target = profiles.find((profile) => profile.id === last) ?? profiles[0];

  useEffect(() => {
    if (target) router.replace(agentPath(target.id));
  }, [router, target]);

  return target ? <Loading /> : <NoAgents />;
}
