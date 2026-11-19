import { create } from 'zustand';

export type AgentSettingsPage = 'identity' | 'memories' | 'channels';

type AgentOverlay = {
  /** The page open in the agent's settings; closed without one. */
  settings?: AgentSettingsPage;
  openSettings: (page?: AgentSettingsPage) => void;
  closeSettings: () => void;
};

/** What is open over the agent's conversation: its settings. */
export const useAgentOverlay = create<AgentOverlay>()((set) => ({
  openSettings: (settings = 'identity') => set({ settings }),
  closeSettings: () => set({ settings: undefined }),
}));
