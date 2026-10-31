import { useCallback, useEffect, useState } from 'react';
import type { GatewaySummary } from '../../shared/bridge';
import { desktop } from '../desktop';
import { chatAt, navigationFor, profileAt } from './navigation';

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

  // The main process notifies for every conversation but the one the window shows: it hears of
  // each move between chats, not only between gateways.
  const shown = current?.id;
  useEffect(() => {
    if (!shown) {
      desktop().showing(null);
      return;
    }
    const navigation = navigationFor(shown);
    const tell = () => {
      const chat = chatAt(navigation.current());
      const profileId = profileAt(navigation.current());
      desktop().showing({
        gatewayId: shown,
        ...(chat ? { chat } : {}),
        ...(profileId ? { profileId } : {}),
      });
    };
    tell();
    const stop = navigation.subscribe(tell);
    return () => {
      stop();
    };
  }, [shown]);

  return { current, select };
}
