'use client';

import { useQueryErrorResetBoundary } from '@tanstack/react-query';
import { Loading } from '../components/shell/states';

/**
 * What a section shows when a slice it reads could not be read. Trying again clears the failed
 * queries first, so the section asks the gateway again instead of rendering the same error.
 */
export function Failed({ retry }: { retry: () => void }) {
  const { reset } = useQueryErrorResetBoundary();

  return (
    <Loading
      retry={() => {
        reset();
        retry();
      }}
    />
  );
}
