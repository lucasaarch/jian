import { queryOptions } from '@tanstack/react-query';
import { panelApi } from '../../lib/query/client';
import { keys } from '../../lib/query/keys';

/**
 * How this server installation updates, and whether a release is waiting. The gateway keeps
 * GitHub's answer a while itself, so a read now and then costs nothing; a gateway from before
 * updates existed answers 404, which leaves everything about them hidden.
 */
export const updateStatus = () =>
  queryOptions({
    queryKey: keys.updates,
    queryFn: () => panelApi().updateStatus(),
    staleTime: 15 * 60_000,
    retry: false,
  });

/** The release's note on GitHub; tags carry a `v`, images do not. */
export const releaseUrl = (version: string) =>
  `https://github.com/lucasaarch/jian/releases/tag/v${version}`;
