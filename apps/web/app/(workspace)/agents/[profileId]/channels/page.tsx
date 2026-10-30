'use client';

import { Channels } from '@/components/channels';
import { useActions } from '@/lib/workspace';

export default function Page() {
  return <Channels {...useActions()} />;
}
