'use client';

import { useRouter } from 'next/navigation';
import { SignIn } from '../../components/sign-in';

export default function Page() {
  const router = useRouter();

  return <SignIn connected={() => router.replace('/')} />;
}
