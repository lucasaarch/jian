import type { RunProgress } from '@jian/contracts';
import { create } from 'zustand';

/** What the agent has written so far of an Artifact its tool call is still making. */
export type ArtifactDraft = NonNullable<RunProgress['artifact']> & {
  /** The tool call ended: what is held is the last of it, kept until the real version is drawn. */
  done?: boolean;
};

type Drafts = {
  /** By conversation. Never persisted: it is a preview, and the version is what is kept. */
  byConversation: Record<string, ArtifactDraft | undefined>;
  /**
   * The stream told what the turn is writing, or that it writes none. Returns true when it is a
   * call not seen before, which is what opens the Inspector on it, once.
   */
  tell: (sessionId: string, draft: RunProgress['artifact']) => boolean;
  forget: (sessionId: string) => void;
};

export const useArtifactDraft = create<Drafts>((set, get) => ({
  byConversation: {},
  tell: (sessionId, draft) => {
    const before = get().byConversation[sessionId];
    if (!draft) {
      // Kept, marked over: the drawn version replaces it only once that is ready.
      if (before && !before.done)
        set({
          byConversation: { ...get().byConversation, [sessionId]: { ...before, done: true } },
        });
      return false;
    }
    set({ byConversation: { ...get().byConversation, [sessionId]: draft } });
    return before?.toolCallId !== draft.toolCallId;
  },
  forget: (sessionId) => {
    if (!get().byConversation[sessionId]) return;
    set({ byConversation: { ...get().byConversation, [sessionId]: undefined } });
  },
}));
