import { create } from 'zustand';

export type AgentSettingsPage = 'identity' | 'skills' | 'memories' | 'channels' | 'activity';
/** The schedule open in its overlay, or a new one being written. */
type OpenSchedule = string | 'new';

type AgentOverlay = {
  /** The page open in the agent's settings; closed without one. */
  settings?: AgentSettingsPage;
  schedules: boolean;
  schedule?: OpenSchedule;
  openSettings: (page?: AgentSettingsPage) => void;
  closeSettings: () => void;
  openSchedules: () => void;
  closeSchedules: () => void;
  selectSchedule: (schedule: OpenSchedule | undefined) => void;
};

/** What is open over the agent's conversation: its settings, or its schedules. */
export const useAgentOverlay = create<AgentOverlay>()((set) => ({
  schedules: false,
  openSettings: (settings = 'identity') => set({ settings, schedules: false }),
  closeSettings: () => set({ settings: undefined }),
  openSchedules: () => set({ schedules: true, schedule: undefined, settings: undefined }),
  closeSchedules: () => set({ schedules: false }),
  selectSchedule: (schedule) => set({ schedule }),
}));
