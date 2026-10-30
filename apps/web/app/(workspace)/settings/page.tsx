import { redirect } from 'next/navigation';
import { settingsPath } from '@/lib/navigation';

/** `/settings` alone opens the first of the gateway's screens. */
export default function Page() {
  redirect(settingsPath('providers'));
}
