'use client';

import { ModelDefaults } from '@/components/providers/model-defaults';
import { useActions } from '@/lib/workspace';

export default function Page() {
  return <ModelDefaults {...useActions()} />;
}
