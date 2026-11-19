'use client';

import { useRef } from 'react';
import { useArtifactDraft } from '../../../lib/stores/artifact-draft';
import { useCrew } from '../../../lib/stores/crew';
import { useDrawerFocus } from '../crew';
import { InspectorContent } from '../inspector-host';
import { ArtifactCards, type ArtifactsDrawerApi } from './artifact-cards';
import { LiveCreation } from './artifact-live';
import { ArtifactView } from './artifact-view';
import { useArtifactsFollow, useSessionArtifacts } from './use-artifacts';
import { useDraftHandoff } from './use-draft-handoff';

/**
 * The Inspector's Artifacts tab: what the agent made in this conversation for the owner to see,
 * as cards (artifact-cards.tsx), and one of them drawn (artifact-view.tsx). The agent making or
 * updating one opens it here by itself (useArtifactsFollow). A new version is the agent's, or
 * the owner's own when they edit a page or a slide by hand there.
 */
export function ArtifactsDrawer({
  api,
  profileId,
  ask,
}: {
  api: ArtifactsDrawerApi;
  profileId: string;
  /**
   * Sends the owner's message in this conversation, as its composer does, for Fix on an Artifact
   * that failed. None where the panel cannot write to the conversation, as on a channel.
   */
  ask?: ((text: string) => void) | undefined;
}) {
  const tabs = useCrew((state) => state.tabs);
  const following = useCrew((state) => state.following);
  const conversation = useCrew((state) => state.sessionId);
  const closer = useRef<HTMLButtonElement>(null);
  const found = tabs.find((item) => item.kind === 'artifacts' && item.key === following);
  const tab = found?.kind === 'artifacts' ? found : undefined;
  const listing = useSessionArtifacts(api, profileId, tab?.sessionId);

  const draft = useArtifactDraft(
    (state) => state.byConversation[tab?.sessionId ?? conversation ?? ''],
  );
  // Held across the render that opens the drawer on a draft, so that the opening moves no focus.
  const quiet = useRef(false);
  quiet.current = Boolean(draft && !draft.done);
  useDrawerFocus(tab ? following : undefined, closer, quiet);
  useDraftHandoff(api, profileId, tab?.sessionId ?? conversation ?? undefined, draft);
  useArtifactsFollow(profileId, conversation);

  if (!tab) return null;

  // One asked for by an id the list does not hold, as one saved from another gateway: the cards.
  const artifact = listing.data?.find((item) => item.id === tab.artifactId);

  return (
    <InspectorContent>
      <aside className="crew-drawer" aria-label="Artifacts">
        {draft && !draft.artifactId ? (
          <LiveCreation draft={draft} closer={closer} />
        ) : artifact ? (
          <ArtifactView
            key={artifact.id}
            api={api}
            profileId={profileId}
            artifact={artifact}
            closer={closer}
            draft={draft?.artifactId === artifact.id ? draft : undefined}
            onFix={ask}
            onBack={() => useCrew.getState().showArtifacts()}
          />
        ) : (
          <ArtifactCards
            api={api}
            profileId={profileId}
            sessionId={tab.sessionId}
            closer={closer}
          />
        )}
      </aside>
    </InspectorContent>
  );
}
