import type { ThisComputer } from '@jian/ui';
import { useEffect, useState } from 'react';
import type { GatewaySummary } from '../../shared/bridge';
import { desktop } from '../desktop';

/**
 * The computer the app runs on, as a machine of `gateway`: its id there once registered, followed
 * as the main process changes it. None for the app's own gateway, which already runs here.
 */
export function useThisComputer(gateway: GatewaySummary): ThisComputer | undefined {
  const [state, setState] = useState<{ machineId: string | null }>();
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

  return gateway.local || !state ? undefined : state;
}
