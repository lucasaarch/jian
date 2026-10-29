'use client';

import { Overview } from '@/components/overview';
import { panelApi } from '@/lib/query/client';

export default function Page() {
  return <Overview api={panelApi()} />;
}
