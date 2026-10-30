'use client';

import { SignIn } from '@jian/ui';
import { useRouter } from 'next/navigation';

export default function Page() {
  const router = useRouter();

  return <SignIn connected={() => router.replace('/')} />;
}
