'use client';

import { RemoteMachines } from '../../../components/remote';
import { useSection } from '../../../lib/workspace';

export default function Page() {
  return <RemoteMachines api={useSection().api} />;
}
