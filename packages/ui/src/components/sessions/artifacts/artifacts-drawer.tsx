'use client';

import { useRef } from 'react';
import { SkeletonLine, SkeletonRegion, StatusPill } from '../../../kit';
import { useCrew } from '../../../lib/stores/crew';
import { useDrawerFocus } from '../crew';
import { InspectorBar, InspectorBody } from '../inspector';
import { InspectorContent } from '../inspector-host';
import { ArtifactView } from './artifact-view';
import { TYPE_NAME } from './source';
import { type ArtifactsApi, useArtifactsFollow, useSessionArtifacts } from './use-artifacts';

/**
 * The Inspector's Artifacts tab: what the agent made in this conversation for the owner to see,
 * as a list, and one of them drawn (artifact-view.tsx). The agent making or updating one opens
 * it here by itself (useArtifactsFollow). Nothing here edits one: a new version is the agent's.
 */
export function ArtifactsDrawer({ api, profileId }: { api: ArtifactsApi; profileId: string }) {
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

  // One asked for by an id the list does not hold, as one saved from another gateway: the list.
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
          />
        ) : (
          <>
            <InspectorBar closer={closer}>
              <h2 className="text-[13px] font-medium text-ink">Artifacts</h2>
            </InspectorBar>
            <InspectorBody className="px-(--inspector-inset)">
              {listing.isError ? (
                <p role="alert" className="pt-3 text-sm text-muted">
                  {listing.error instanceof Error
                    ? listing.error.message
                    : 'The Artifacts could not be read.'}
                </p>
              ) : !listing.data ? (
                <SkeletonRegion label="Loading artifacts…" className="grid gap-4 pt-3">
                  {['w-40', 'w-28', 'w-36'].map((width) => (
                    <SkeletonLine key={width} className={width} />
                  ))}
                </SkeletonRegion>
              ) : listing.data.length === 0 ? (
                <p className="pt-3 text-sm leading-relaxed text-muted">
                  Nothing here yet. When the agent makes something to look at, such as a page, a
                  component, a document, a picture or a diagram, it is drawn here and kept with
                  every version.
                </p>
              ) : (
                <ul className="grid grid-cols-1 gap-px pt-1">
                  {listing.data.map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-glass-hover"
                        onClick={() => useCrew.getState().showArtifacts(item.id)}
                      >
                        <span className="grid min-w-0 flex-1 grid-cols-1 gap-0.5">
                          <span className="truncate text-[13px] font-medium text-ink">
                            {item.title}
                          </span>
                          <span className="truncate text-xs text-muted">
                            {TYPE_NAME[item.type]} · Version {item.version}
                          </span>
                        </span>
                        {item.visibility === 'public' && (
                          <StatusPill tone="warn">Public</StatusPill>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </InspectorBody>
          </>
        )}
      </aside>
    </InspectorContent>
  );
}
