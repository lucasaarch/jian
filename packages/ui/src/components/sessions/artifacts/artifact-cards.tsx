'use client';

import { type RefObject, useMemo, useState } from 'react';
import { ArtifactCard } from '../../../app/artifacts/artifact-card';
import { attempt, useArtifactDialogs } from '../../../app/artifacts/artifact-dialogs';
import { ArtifactStarters } from '../../../app/artifacts/artifact-starters';
import { ArtifactsGridSkeleton, CARD_COLUMNS } from '../../../app/artifacts/artifacts-grid';
import {
  type ArtifactKeepingApi,
  useArtifactKeeping,
} from '../../../app/artifacts/use-profile-artifacts';
import { Action, FilterSelect, SearchField, SkeletonRegion, surfaceCard } from '../../../kit';
import type { SessionArtifact } from '../../../lib/api';
import { usePhone } from '../../../lib/phone';
import { useArtifactDraft } from '../../../lib/stores/artifact-draft';
import { useCrew } from '../../../lib/stores/crew';
import { draftKey, useDrafts } from '../../../lib/stores/drafts';
import { revealViewer } from '../files/use-files';
import { InspectorBar, InspectorBody } from '../inspector';
import { TYPE_FILTERS } from './source';
import { type ArtifactsApi, useSessionArtifacts } from './use-artifacts';

/** What the Artifacts tab asks of the gateway: what one open Artifact does, and the cards' menu. */
export type ArtifactsDrawerApi = ArtifactsApi & ArtifactKeepingApi;

/** Nothing to do with a folder made here: the Inspector's cards make none. */
const NOWHERE = () => {};

/**
 * The Inspector's Artifacts tab before one is opened: what the agent made in this conversation
 * as the Artifacts page shows it, the same cards with the same shortcuts above them, fitted to
 * the Inspector's column. Its search and its type are in the Inspector's bar, as the Files tab's
 * are, and narrow what was read already: a conversation's Artifacts come in one answer. Create
 * something new begins the request in this conversation's own field, after what is written
 * there, and brings the field into sight; nothing is sent until the owner sends it. A card's
 * menu renames, duplicates or deletes it and copies its public link; pins and folders are the
 * page's, which keeps them across every conversation.
 */
export function ArtifactCards({
  api,
  profileId,
  sessionId,
  closer,
}: {
  api: ArtifactsDrawerApi;
  profileId: string;
  sessionId: string;
  closer: RefObject<HTMLButtonElement | null>;
}) {
  const listing = useSessionArtifacts(api, profileId, sessionId);
  const phone = usePhone();
  const draft = useArtifactDraft((state) => state.byConversation[sessionId]);
  const [words, setWords] = useState('');
  const [type, setType] = useState<'' | SessionArtifact['type']>('');
  const keeping = useArtifactKeeping(api, profileId);
  const { name, doom, dialogs } = useArtifactDialogs(keeping, NOWHERE);

  const needle = words.trim().toLowerCase();
  const narrowed = Boolean(needle || type);
  const shown = useMemo(
    () =>
      listing.data?.filter(
        (item) =>
          (!type || item.type === type) && (!needle || item.title.toLowerCase().includes(needle)),
      ),
    [listing.data, needle, type],
  );

  const start = (prompt: string) => {
    useDrafts.getState().begin(draftKey(profileId, sessionId), prompt);
    // The field is the chat's: where the Inspector stands over it, it makes way.
    revealViewer(phone);
  };

  return (
    <>
      <InspectorBar closer={closer} spread>
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <SearchField
            label="Search artifacts"
            value={words}
            onValueChange={setWords}
            // The first Escape takes back what was typed; only the next reaches the Inspector.
            onKeyDown={(event) => {
              if (event.key !== 'Escape' || !words) return;
              event.stopPropagation();
              setWords('');
            }}
            className="h-7 flex-1"
          />
          <FilterSelect
            label="Type"
            value={type}
            options={TYPE_FILTERS}
            onValueChange={(next) => setType(next as '' | SessionArtifact['type'])}
            className="h-7"
          />
        </div>
      </InspectorBar>
      <InspectorBody className="px-(--inspector-inset)">
        <div className="grid min-w-0 grid-cols-1 gap-5 pt-2">
          {!narrowed && <ArtifactStarters narrow onStart={start} />}
          {listing.isError ? (
            <div className="grid justify-items-start gap-3">
              <p role="alert" className="text-sm text-muted">
                {listing.error instanceof Error
                  ? listing.error.message
                  : 'The Artifacts could not be read.'}
              </p>
              <Action onClick={() => void listing.refetch()}>Try again</Action>
            </div>
          ) : !shown ? (
            <SkeletonRegion label="Loading artifacts…">
              <ArtifactsGridSkeleton count={4} columns={CARD_COLUMNS.inspector} />
            </SkeletonRegion>
          ) : shown.length > 0 ? (
            <ul aria-label="Artifacts" className={`min-w-0 ${CARD_COLUMNS.inspector}`}>
              {shown.map((artifact) => (
                <ArtifactCard
                  key={artifact.id}
                  api={api}
                  profileId={profileId}
                  artifact={artifact}
                  writing={Boolean(draft && draft.artifactId === artifact.id && !draft.done)}
                  onOpen={() => useCrew.getState().showArtifacts(artifact.id)}
                  tools={{
                    rename: () => name({ kind: 'artifact', artifact }),
                    duplicate: () =>
                      void attempt(
                        () => keeping.duplicate(artifact),
                        `Duplicated ${artifact.title}.`,
                      ),
                    delete: () => doom({ artifact }),
                  }}
                />
              ))}
            </ul>
          ) : (
            <p className={`px-4 py-3 text-[13px] leading-relaxed text-muted ${surfaceCard}`}>
              {narrowed
                ? 'No Artifact matches.'
                : 'Nothing here yet. When the agent makes something to look at, such as a page, a component, a document, a diagram or slides, it is shown here and kept with every version.'}
            </p>
          )}
        </div>
      </InspectorBody>
      {dialogs}
    </>
  );
}
