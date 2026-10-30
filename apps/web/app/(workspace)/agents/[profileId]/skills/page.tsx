'use client';

import { Skills } from '@/components/skills';
import { useActions } from '@/lib/workspace';

export default function Page() {
  return <Skills {...useActions()} />;
}
