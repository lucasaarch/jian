'use client';

import { useQueryErrorResetBoundary } from '@tanstack/react-query';
import { Loading } from '@/components/shell/states';

/**
 * A gateway resource that could not be read. Trying again clears the failed queries first,
 * so the page asks the gateway again instead of rendering the same error.
 */
export default function SettingsError({ retry }: { error: Error; retry: () => void }) {
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
