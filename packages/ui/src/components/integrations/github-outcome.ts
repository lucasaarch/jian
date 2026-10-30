'use client';

import { useEffect } from 'react';
import { toast } from 'sonner';
import { githubOutcome } from '../../lib/github';
import { usePathname, useRouter, useSearchParams } from '../../platform/navigation';

/**
 * GitHub sends the owner back with the outcome in the query: it is said once, then dropped from
 * the address. Read through the host's navigation, it reaches the panel whether the browser
 * came back to the web host or a desktop app opened at the same place.
 */
export function useGithubOutcome(): void {
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    const outcome = githubOutcome(params);
    if (!outcome) return;
    if (outcome.failed) toast.error(outcome.text, { duration: 12_000 });
    else toast.success(outcome.text);
    const rest = new URLSearchParams(params);
    rest.delete('github');
    rest.delete('reason');
    const query = rest.toString();
    router.replace(`${pathname}${query ? `?${query}` : ''}`);
  }, [params, pathname, router]);
}
