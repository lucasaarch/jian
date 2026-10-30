import type { ThisComputer } from '@jian/ui';
import { useCallback, useEffect, useState } from 'react';
import type { GatewaySummary } from '../../shared/bridge';
import { desktop } from '../desktop';

/**
 * The computer the app runs on, as a machine of `gateway`: its id there once registered, and
 * whether agents may use it, followed as the main process changes either. None for the app's
 * own gateway, which already runs on this computer.
 */
export function useThisComputer(gateway: GatewaySummary): ThisComputer | undefined {
  const [state, setState] = useState<{ machineId: string | null; sharing: boolean }>();
  const id = gateway.id;

  useEffect(() => {
    if (gateway.local) return;
    let current = true;
    const read = () =>
      void desktop()
        .machines.state(id)
        .then((next) => current && setState(next));
    read();
    const stop = desktop().machines.onChanged(read);
    return () => {
      current = false;
      stop();
    };
  }, [id, gateway.local]);

  const setSharing = useCallback((on: boolean) => desktop().machines.setSharing(on), []);

  return gateway.local || !state ? undefined : { ...state, setSharing };
}
