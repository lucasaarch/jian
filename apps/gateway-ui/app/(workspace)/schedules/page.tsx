'use client';

import { Schedules } from '../../../components/schedules/index';
import { useSection } from '../../../lib/workspace';

export default function Page() {
  return <Schedules {...useSection()} />;
}
