'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Campaigns } from '../../../components/campaigns';
import { useSection, useWorkspace } from '../../../lib/workspace';

export default function Page() {
  const section = useSection();
  const { profile } = useWorkspace();
  const router = useRouter();
  const allowed = profile?.professionId === 'attendant';

  useEffect(() => {
    if (!allowed) router.replace('/');
  }, [allowed, router]);

  return allowed ? <Campaigns {...section} /> : null;
}
