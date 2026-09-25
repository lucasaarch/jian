'use client';

import { Capabilities } from '../../../components/skills/index';
import { useSection, useWorkspace } from '../../../lib/workspace';

export default function Page() {
  const { profiles } = useWorkspace();

  return <Capabilities {...useSection()} kind="mcpServers" others={profiles} />;
}
