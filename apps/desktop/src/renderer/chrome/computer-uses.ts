import type { ComputerUse } from '@jian/ui';
import { useEffect, useState } from 'react';
import type { GatewaySummary, MachineUse } from '../../shared/bridge';
import { desktop } from '../desktop';

/**
 * What agents are doing on this computer now, each named by the gateway it came from. Read once
 * as the window opens, then followed as the main process hears each task start and end.
 */
export function useComputerUses(gateways: GatewaySummary[]): ComputerUse[] {
  const [uses, setUses] = useState<MachineUse[]>([]);
  useEffect(() => {
    let live = true;
    void desktop()
      .machines.using()
      .then((now) => live && setUses(now));
    const stop = desktop().machines.onUsing(setUses);
    return () => {
      live = false;
      stop();
    };
  }, []);
  return uses.map((use) => ({
    gateway: gateways.find((gateway) => gateway.id === use.gatewayId)?.name ?? 'a gateway',
    kind: use.kind,
  }));
}
