import { create } from 'zustand';

type Shell = {
  /** The "new agent" dialog, opened from the switcher, the empty workspace or a missing agent. */
  creating: boolean;
  setCreating: (creating: boolean) => void;
  /**
   * The release history, opened on purpose from the sidebar. The notes that open by themselves
   * after an update are the gateway's to decide, not this flag.
   */
  releaseNotes: boolean;
  setReleaseNotes: (open: boolean) => void;
};

export const useShell = create<Shell>()((set) => ({
  creating: false,
  setCreating: (creating) => set({ creating }),
  releaseNotes: false,
  setReleaseNotes: (releaseNotes) => set({ releaseNotes }),
}));
