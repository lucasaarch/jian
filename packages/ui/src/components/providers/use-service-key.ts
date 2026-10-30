'use client';

import { useEffect, useState } from 'react';
import type { Mutation } from '../../lib/api';

/**
 * The state of a service the installation reaches through one key, read when the screen opens
 * and replaced by what each change answers. A read that fails leaves it unknown.
 */
export function useServiceKey<S>(load: () => Promise<S>, mutate: Mutation) {
  const [status, setStatus] = useState<S>();

  useEffect(() => {
    let active = true;
    void load()
      .then((state) => {
        if (active) setStatus(state);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [load]);

  /** Runs a change through `mutate`, so it is said and its failure shown; false when it failed. */
  const change = async (action: () => Promise<S>, done: string) => {
    let next: S | undefined;
    const ok = await mutate(async () => {
      next = await action();
    }, done);
    if (ok && next) setStatus(next);
    return ok;
  };

  return { status, change };
}
