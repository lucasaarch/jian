import type { RunProgress } from '@jian/contracts';
import { onPhone } from '../../../lib/phone';
import { useArtifactDraft } from '../../../lib/stores/artifact-draft';
import { useCrew } from '../../../lib/stores/crew';

/**
 * What a progress frame of the conversation on screen says of an Artifact being written. The
 * first frame of a call opens the Inspector on it, as the agent's own request to show one does,
 * and that is all it does: no focus moves, so the owner's typing in the composer goes on. On a
 * phone the Inspector covers the chat, so it is left closed; the Artifacts tab shows the writing
 * when the owner opens it.
 */
export function hearArtifactDraft(sessionId: string, draft: RunProgress['artifact']) {
  const opens = useArtifactDraft.getState().tell(sessionId, draft);
  if (opens && draft && !onPhone()) useCrew.getState().showArtifacts(draft.artifactId);
}
