'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { SshKeys } from '../../../components/ssh-keys';
import { useSection, useWorkspace } from '../../../lib/workspace';

export default function Page() {
  const section = useSection();
  const { profile } = useWorkspace();
  const router = useRouter();
  const allowed = profile?.professionId === 'developer';

  useEffect(() => {
    if (!allowed) router.replace('/');
  }, [allowed, router]);

  return allowed ? <SshKeys {...section} /> : null;
}
