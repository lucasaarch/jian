'use client';

import { Schedules } from '@/components/schedules';
import { useActions } from '@/lib/workspace';

export default function Page() {
  return <Schedules {...useActions()} />;
}
