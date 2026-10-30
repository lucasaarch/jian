'use client';

import { Failed } from '@jian/ui';

/** A slice this section reads could not be read: it offers to read it again. */
export default function SectionError({ retry }: { error: Error; retry: () => void }) {
  return <Failed retry={retry} />;
}
