'use client';

import { Providers } from '@/components/providers';
import { useActions } from '@/lib/workspace';

export default function Page() {
  return <Providers {...useActions()} />;
}
