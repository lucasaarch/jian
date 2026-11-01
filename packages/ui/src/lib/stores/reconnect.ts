import { create } from 'zustand';

/**
 * Asked for by the owner, from wherever the panel offers it: each number going up reads something
 * again. Reconnecting reopens the gateway's event stream and reads everything on screen, the open
 * chat included; reloading a chat reads only its history. Never kept.
 */
export const useReconnect = create<{
  connection: number;
  chat: number;
  reconnect: () => void;
  reloadChat: () => void;
}>()((set) => ({
  connection: 0,
  chat: 0,
  reconnect: () => set((state) => ({ connection: state.connection + 1, chat: state.chat + 1 })),
  reloadChat: () => set((state) => ({ chat: state.chat + 1 })),
}));

export const reconnectGateway = () => useReconnect.getState().reconnect();
