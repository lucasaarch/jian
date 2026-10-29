'use client';

import type { UseQueryResult } from '@tanstack/react-query';
import { useEffect } from 'react';
import { notifyError } from '@/lib/workspace';

/**
 * Says so once when a read the screen can live without fails, such as the GitHub App beside the
 * MCP servers. A read the screen cannot live without suspends instead, and fails into
 * the agent's error page.
 */
export function useReportFailure<T>(query: UseQueryResult<T>, fallback: string): UseQueryResult<T> {
  const { error } = query;

  useEffect(() => {
    if (error) notifyError(error, fallback);
  }, [error, fallback]);

  return query;
}
