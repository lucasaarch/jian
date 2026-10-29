'use client';

import { SshKeys } from '@/components/ssh-keys';
import { useActions } from '@/lib/workspace';

export default function Page() {
  return <SshKeys {...useActions()} />;
}
