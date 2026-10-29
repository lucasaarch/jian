'use client';

import { ProfileEditor } from '@/components/profile/editor';
import { useActions } from '@/lib/workspace';

export default function Page() {
  return <ProfileEditor {...useActions()} />;
}
