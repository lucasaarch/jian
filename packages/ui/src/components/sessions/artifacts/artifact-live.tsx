'use client';

import { type RefObject, useEffect, useRef } from 'react';
import type { ArtifactDraft } from '../../../lib/stores/artifact-draft';
import { Markdown } from '../../ui/markdown';
import { InspectorBody } from '../inspector';
import { ArtifactBar } from './artifact-bar';
import { Building } from './live/building';
import { LiveDeck } from './live/live-deck';
import { LiveSheet } from './live/live-sheet';

export { LiveSheet };

/**
 * The quiet word beside a title while the agent is still writing the Artifact: Writing… while it
 * makes one, Updating… while it changes one that is drawn.
 */
export function WritingChip({ updating = false }: { updating?: boolean }) {
  return (
    <span role="status" className="shrink-0 text-xs font-normal text-muted">
      {updating ? 'Updating…' : 'Writing…'}
    </span>
  );
}

/**
 * A light passing along the top of an Artifact the agent is changing, over the version still in
 * view: it takes no room and no click, and the owner goes on reading or editing under it.
 */
export function UpdatingLine() {
  return <div aria-hidden="true" className="artifact-updating" />;
}

/** A document as it is written, read as the document it is becoming, following its end. */
function LiveDocument({ draft }: { draft: ArtifactDraft }) {
  const end = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the content is what moves the end.
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'end' });
  }, [draft.content]);

  return (
    <InspectorBody className="px-(--inspector-inset)">
      <article className="viewer-document release-notes pb-4">
        <Markdown text={draft.content} streaming={!draft.done} />
      </article>
      <div ref={end} />
    </InspectorBody>
  );
}

/**
 * What stands for an Artifact being made, by its type. Nothing half written is run or shown as
 * code: a document is read as it is written, a spreadsheet fills in cell by cell, a deck shows
 * each slide once it is whole, and the rest are the shape of what is coming until the version
 * that draws them lands (live/building.tsx).
 */
function LiveBody({ draft }: { draft: ArtifactDraft }) {
  if (draft.type === 'sheet' && draft.content) {
    return <LiveSheet content={draft.content} done={draft.done} />;
  }
  if (draft.type === 'markdown' && draft.content) return <LiveDocument draft={draft} />;
  if (draft.type === 'deck' && draft.slides?.length) {
    return <LiveDeck draft={{ ...draft, slides: draft.slides }} />;
  }
  return <Building draft={draft} />;
}

/** An Artifact that does not exist yet: its bar and its making, in the Inspector's place. */
export function LiveCreation({
  draft,
  closer,
}: {
  draft: ArtifactDraft;
  closer: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <>
      <ArtifactBar
        page={false}
        closer={closer}
        back={null}
        title={draft.title || 'New artifact'}
        status={draft.done ? undefined : <WritingChip />}
        options={null}
      />
      <LiveBody draft={draft} />
    </>
  );
}
