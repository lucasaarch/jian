'use client';

import { RemoteMachines } from '@/components/remote';
import { panelApi } from '@/lib/query/client';

export default function Page() {
  return <RemoteMachines api={panelApi()} />;
}
