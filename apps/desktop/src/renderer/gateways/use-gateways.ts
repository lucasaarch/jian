import { useCallback, useEffect, useState } from 'react';
import type { GatewaySummary } from '../../shared/bridge';
import { desktop } from '../desktop';

/** The gateways in the app and how each stands, as the main process keeps them. */
export function useGateways(): { gateways: GatewaySummary[]; loaded: boolean } {
  const [gateways, setGateways] = useState<GatewaySummary[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let live = true;
    void desktop()
      .gateways()
      .then((list) => {
        if (!live) return;
        setGateways(list);
        setLoaded(true);
      });
    const stop = desktop().onGatewaysChanged(setGateways);
    return () => {
      live = false;
      stop();
    };
  }, []);

  return { gateways, loaded };
}

const SELECTED = 'jian.desktop.gateway';

/** The gateway the window shows, kept across launches; the first one when it was removed. */
export function useSelectedGateway(gateways: GatewaySummary[]) {
  const [selected, setSelected] = useState<string | null>(() => {
    try {
      return localStorage.getItem(SELECTED);
    } catch {
      return null;
    }
  });
  const current = gateways.find((gateway) => gateway.id === selected) ?? gateways[0];

  const select = useCallback((id: string) => {
    setSelected(id);
    try {
      localStorage.setItem(SELECTED, id);
    } catch {
      // Only the next launch forgets it.
    }
  }, []);

  // The main process notifies only for what the window does not show.
  useEffect(() => {
    desktop().showing(current?.id ?? null);
  }, [current?.id]);

  return { current, select };
}
