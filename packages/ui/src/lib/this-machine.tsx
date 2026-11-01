'use client';

import { createContext, useContext } from 'react';

/**
 * The computer the panel runs on, for a host that can reach it: the desktop app. A browser cannot,
 * so on the web there is none, and every machine is remote.
 */
export type ThisMachine = {
  /** Asks the owner for a folder; null when they cancel. */
  pickFolder: () => Promise<string | null>;
  /**
   * Its id as a machine of this gateway. Null where it is not one: on the app's own gateway, which
   * runs here anyway, or until a server has registered it.
   */
  machineId: string | null;
  /** The gateway runs on this computer itself, so it needs no machine to reach it. */
  ownGateway: boolean;
  /** Whether agents on a server may use this computer at all. */
  sharing: boolean;
  setSharing: (on: boolean) => void;
};

const Context = createContext<ThisMachine | undefined>(undefined);
export const ThisMachineProvider = Context.Provider;
export const useThisMachine = () => useContext(Context);
