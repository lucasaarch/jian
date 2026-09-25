'use client';

import { Stickers } from '../../../components/stickers/index';
import { useSection } from '../../../lib/workspace';

export default function Page() {
  return <Stickers {...useSection()} />;
}
