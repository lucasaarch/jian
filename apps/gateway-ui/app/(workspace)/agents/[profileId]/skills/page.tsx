'use client';

import { Capabilities } from '@/components/skills';
import { useActions } from '@/lib/workspace';

export default function Page() {
  return <Capabilities {...useActions()} kind="skills" />;
}
