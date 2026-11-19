'use client';

import { type RefObject, useEffect, useRef } from 'react';
import type { ArtifactDraft } from '../../../lib/stores/artifact-draft';
import { CodeBlock } from '../../ui/code-block';
import { Markdown } from '../../ui/markdown';
import { InspectorBody } from '../inspector';
import { ArtifactBar } from './artifact-bar';
import { LANGUAGE } from './source';

/** The quiet word beside a title while the agent is still writing the Artifact. */
export function WritingChip() {
  return (
    <span role="status" className="shrink-0 text-xs font-normal text-muted">
      Writing…
    </span>
  );
}

/**
 * What the agent has written of an Artifact so far. A document is read as the document it is
 * becoming; every other type shows its source growing, since a page half written draws nothing
 * worth seeing. It follows the end of what is written, where the agent is.
 */
export function LiveArtifact({ draft }: { draft: ArtifactDraft }) {
  const end = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the content is what moves the end.
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'end' });
  }, [draft.content]);

  return (
    <InspectorBody className="px-(--inspector-inset)">
      {draft.type === 'markdown' ? (
        <article className="viewer-document release-notes pb-4">
          <Markdown text={draft.content} streaming={!draft.done} />
        </article>
      ) : (
        <CodeBlock
          text={draft.content}
          language={draft.type && LANGUAGE[draft.type]}
          wrapped
          plain
        />
      )}
      <div ref={end} />
    </InspectorBody>
  );
}

/** An Artifact that does not exist yet: its bar and its writing, in the Inspector's place. */
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
      <LiveArtifact draft={draft} />
    </>
  );
}
