'use client';

import { Memories } from '@/components/memories';
import { useActions } from '@/lib/workspace';

export default function Page() {
  return <Memories {...useActions()} />;
}
