'use client';

import { useRef } from 'react';
import { useCrew } from '../../../lib/stores/crew';
import { useDrawerFocus } from '../crew';
import { InspectorContent } from '../inspector-host';
import { ArtifactCards, type ArtifactsDrawerApi } from './artifact-cards';
import { ArtifactView } from './artifact-view';
import { useArtifactsFollow, useSessionArtifacts } from './use-artifacts';

/**
 * The Inspector's Artifacts tab: what the agent made in this conversation for the owner to see,
 * as cards (artifact-cards.tsx), and one of them drawn (artifact-view.tsx). The agent making or
 * updating one opens it here by itself (useArtifactsFollow). A new version is the agent's, or
 * the owner's own when they edit a page or a slide by hand there.
 */
export function ArtifactsDrawer({
  api,
  profileId,
}: {
  api: ArtifactsDrawerApi;
  profileId: string;
}) {
  const tabs = useCrew((state) => state.tabs);
  const following = useCrew((state) => state.following);
  const conversation = useCrew((state) => state.sessionId);
  const closer = useRef<HTMLButtonElement>(null);
  const found = tabs.find((item) => item.kind === 'artifacts' && item.key === following);
  const tab = found?.kind === 'artifacts' ? found : undefined;
  const listing = useSessionArtifacts(api, profileId, tab?.sessionId);

  useDrawerFocus(tab ? following : undefined, closer);
  useArtifactsFollow(profileId, conversation);

  if (!tab) return null;

  // One asked for by an id the list does not hold, as one saved from another gateway: the cards.
  const artifact = listing.data?.find((item) => item.id === tab.artifactId);

  return (
    <InspectorContent>
      <aside className="crew-drawer" aria-label="Artifacts">
        {artifact ? (
          <ArtifactView
            key={artifact.id}
            api={api}
            profileId={profileId}
            artifact={artifact}
            closer={closer}
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
