'use client';

import { useState } from 'react';
import type { McpStatus } from '../../lib/api';

/** One connection check at a time, of a saved server or of what the form holds. */
export function useMcpCheck(run: () => Promise<McpStatus>) {
  const [status, setStatus] = useState<McpStatus>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  return {
    status,
    error,
    busy,
    check: async () => {
      setBusy(true);
      setError('');

      try {
        setStatus(await run());
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : 'The check could not run.');
      } finally {
        setBusy(false);
      }
    },
    /** Forgets the answer, once what it answered for has changed. */
    reset: () => {
      setStatus(undefined);
      setError('');
    },
  };
}
