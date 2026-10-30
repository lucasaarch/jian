import { redirect } from 'next/navigation';

/** `/settings` alone opens the first of the gateway's screens. */
export default function Page() {
  redirect('/settings/providers');
}
