'use client';

import { EDITABLE_ARTIFACT_TYPES } from '@jian/contracts';
import {
  ArrowLeft,
  Code,
  Eye,
  Pencil,
  Presentation as PresentIcon,
  SlidersHorizontal,
} from 'lucide-react';
import { type RefObject, useRef, useState } from 'react';
import { Action, HoverTip, iconButton, SkeletonLine, SkeletonRegion } from '../../../kit';
import type { SessionArtifact } from '../../../lib/api';
import { useGatewayMode } from '../../../lib/gateway-mode';
import type { ArtifactDraft } from '../../../lib/stores/artifact-draft';
import { CodeBlock } from '../../ui/code-block';
import { InspectorBody } from '../inspector';
import { ArtifactBar, SaveStatus } from './artifact-bar';
import { ArtifactDownload } from './artifact-download';
import { ArtifactFrame } from './artifact-frame';
import { ArtifactHistory } from './artifact-history';
import { LiveArtifact, WritingChip } from './artifact-live';
import { ArtifactOptions } from './artifact-options';
import { ArtifactSharing } from './artifact-sharing';
import { DeckDownload } from './deck/deck-download';
import { DeckView } from './deck/deck-view';
import { Presentation } from './deck/presentation';
import { fileName, LANGUAGE } from './source';
import { TweaksPanel } from './tweaks/tweaks-panel';
import { useTweaks } from './tweaks/use-tweaks';
import { type ArtifactsApi, useArtifactVersion } from './use-artifacts';
import { useAutosave } from './use-autosave';

/** What Edit changes, by type: the words of a page, a sheet's cells. */
const EDIT_TIP: Partial<Record<SessionArtifact['type'], string>> = {
  sheet: 'Edit the cells',
};

/**
 * One Artifact, in the Inspector or in the agent's page of every Artifact (app/artifacts): drawn
 * in its sealed frame, or as its source, at the version the owner picks from its history. With none picked it is the latest, and follows the agent's
 * updates; an older one in view is named beside the title. Mount it with the Artifact's id as
 * its key, so another one starts drawn and at its latest.
 *
 * A deck is read as slides, never as code: a slide's markup is still copied from the options,
 * and the deck is taken away as a file from a menu of its own (deck/deck-download.tsx).
 *
 * A page, a deck's slide, a document and a spreadsheet can be edited by hand, in the frame
 * that edits (artifact-frame.tsx). A document and a sheet are open for it as they are shown; a
 * page and a deck open on Edit and close on Done. Nothing is saved by hand: use-autosave.ts asks
 * the frame for the source as the owner pauses or leaves, and the gateway keeps one stretch of
 * editing as one version of the owner's. The frame saves nothing itself.
 *
 * A React component is tried out beside its canvas, in Tweaks (tweaks/tweaks-panel.tsx): the
 * props it declares and the theme it is drawn in. It opens by itself on one that declares props.
 */
export function ArtifactView({
  api,
  profileId,
  artifact,
  closer,
  page = false,
  onBack,
  draft,
}: {
  api: ArtifactsApi;
  profileId: string;
  artifact: SessionArtifact;
  /** The Inspector's way out, which the page of every Artifact has none of. */
  closer?: RefObject<HTMLButtonElement | null>;
  /** On the agent's page of every Artifact: its bar is the screen's, not the Inspector's. */
  page?: boolean;
  /** Back to the list it was opened from. */
  onBack: () => void;
  /** What the agent is writing of this Artifact now, if it is revising it. */
  draft?: ArtifactDraft | undefined;
}) {
  const [picked, setPicked] = useState<number>();
  const [code, setCode] = useState(false);
  // The slide of a deck in view, counted from 0.
  const [at, setAt] = useState(0);
  // A page and a deck are edited after Edit; a document and a sheet are always open.
  const [toggled, setToggled] = useState(false);
  // The version the owner's stretch of editing started on. It is held from the first change: an
  // update of the agent's meanwhile must not take the page from under the owner's hands.
  const [held, setHeld] = useState<number>();
  const [presenting, setPresenting] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  // Only a server gateway makes one public, or draws a deck or a document into a PDF, so nothing
  // else offers either; until the gateway says which it is, neither does this.
  const server = useGatewayMode() === 'server';
  const version = held ?? picked ?? artifact.version;
  const read = useArtifactVersion(api, profileId, artifact.sessionId, artifact.id, version);
  const slides = artifact.type === 'deck' ? read.data?.slides : undefined;
  const slide = slides ? Math.min(at, slides.length - 1) : undefined;
  // What is read as code, copied and downloaded: the source as written, or the slide in view.
  const source = slide === undefined ? read.data?.content : slides?.[slide];
  const editable = EDITABLE_ARTIFACT_TYPES.includes(artifact.type);
  const direct = artifact.type === 'markdown' || artifact.type === 'sheet';
  const writing = Boolean(draft && !draft.done);
  // What the agent writes shows in place of the version until the owner has begun to edit it.
  const streaming = Boolean(draft?.content) && held === undefined;
  const editing = editable && !code && !streaming && (direct || toggled);
  // What has a drawing and a source to switch between: all but a deck.
  const sourced = artifact.type !== 'deck';
  const component = artifact.type === 'react';
  const tweaks = useTweaks(frame, component);
  // Open or shut by the owner; until then, open on a component that has props to tweak.
  const [tweaking, setTweaking] = useState<boolean>();
  const tweaksShown =
    component && !code && !streaming && (tweaking ?? (tweaks.tweaks?.length ?? 0) > 0);
  const autosave = useAutosave({
    api,
    profileId,
    artifact,
    frame,
    base: version,
    slide,
    active: editing,
    touched: () => setHeld(version),
  });

  /** Keeps what is being edited and closes the stretch; false when it could not be kept. */
  const settle = async () => {
    if (!(await autosave.end())) return false;
    if (held !== undefined) {
      // Back to the latest, which is now the one just saved.
      setHeld(undefined);
      setPicked(undefined);
    }
    return true;
  };

  return (
    <>
      <ArtifactBar
        page={page}
        closer={closer}
        title={artifact.title}
        old={held !== undefined || version === artifact.version ? undefined : version}
        status={
          writing ? <WritingChip /> : editing ? <SaveStatus state={autosave.state} /> : undefined
        }
        back={
          <HoverTip tip="All artifacts" hoverOnly side="bottom">
            <button
              type="button"
              aria-label="All artifacts"
              className={iconButton}
              onClick={() => void settle().then((kept) => kept && onBack())}
            >
              <ArrowLeft size={15} aria-hidden="true" />
            </button>
          </HoverTip>
        }
        options={
          editing && !direct ? (
            <Action
              size="small"
              tone="primary"
              onClick={() =>
                void settle().then((kept) => {
                  if (kept) setToggled(false);
                })
              }
            >
              Done
            </Action>
          ) : (
            <>
              {sourced && (
                <HoverTip tip={code ? 'Show it drawn' : 'View code'} side="bottom" align="end">
                  <button
                    type="button"
                    aria-label="View code"
                    aria-pressed={code}
                    className={iconButton}
                    onClick={() =>
                      void (code ? setCode(false) : settle().then((kept) => kept && setCode(true)))
                    }
                  >
                    {code ? (
                      <Eye size={15} aria-hidden="true" />
                    ) : (
                      <Code size={15} aria-hidden="true" />
                    )}
                  </button>
                </HoverTip>
              )}
              {component && (
                <HoverTip tip={tweaksShown ? 'Hide tweaks' : 'Tweaks'} side="bottom" align="end">
                  <button
                    type="button"
                    aria-label="Tweaks"
                    aria-pressed={tweaksShown}
                    className={`${iconButton} aria-pressed:bg-glass-press aria-pressed:text-ink`}
                    onClick={() => {
                      setCode(false);
                      setTweaking(!tweaksShown);
                    }}
                  >
                    <SlidersHorizontal size={15} aria-hidden="true" />
                  </button>
                </HoverTip>
              )}
              {slides && (
                <HoverTip tip="Present" side="bottom" align="end">
                  <button
                    type="button"
                    aria-label="Present"
                    className={iconButton}
                    onClick={() => setPresenting(true)}
                  >
                    <PresentIcon size={15} aria-hidden="true" />
                  </button>
                </HoverTip>
              )}
              {editable && !direct && (
                <HoverTip
                  tip={
                    slide === undefined
                      ? (EDIT_TIP[artifact.type] ?? 'Edit the text')
                      : 'Edit this slide’s text'
                  }
                  side="bottom"
                  align="end"
                >
                  <button
                    type="button"
                    aria-label="Edit"
                    disabled={source === undefined}
                    className={iconButton}
                    onClick={() => {
                      setCode(false);
                      setToggled(true);
                    }}
                  >
                    <Pencil size={14} aria-hidden="true" />
                  </button>
                </HoverTip>
              )}
              <ArtifactHistory
                latest={artifact.version}
                version={version}
                onPick={(next) =>
                  void settle().then(
                    (kept) => kept && setPicked(next === artifact.version ? undefined : next),
                  )
                }
              />
              {server && <ArtifactSharing api={api} profileId={profileId} artifact={artifact} />}
              {artifact.type === 'deck' ? (
                <>
                  <DeckDownload
                    api={api}
                    profileId={profileId}
                    artifact={artifact}
                    version={version}
                    slide={slide}
                    source={source}
                    drawn={server}
                  />
                  <ArtifactOptions source={source} what="Slide" />
                </>
              ) : (
                <>
                  {(artifact.type === 'markdown' || artifact.type === 'sheet') && (
                    <ArtifactDownload
                      api={api}
                      profileId={profileId}
                      artifact={artifact}
                      version={version}
                      source={source}
                      drawn={server}
                    />
                  )}
                  <ArtifactOptions
                    source={source}
                    file={
                      artifact.type === 'markdown' || artifact.type === 'sheet'
                        ? undefined
                        : fileName(artifact, version)
                    }
                    what="Source"
                  />
                </>
              )}
            </>
          )
        }
      />

      {streaming && draft ? (
        <LiveArtifact draft={draft} />
      ) : read.isError ? (
        <p role="alert" className="px-(--inspector-inset) pt-3 text-sm text-muted">
          {read.error instanceof Error ? read.error.message : 'The Artifact could not be read.'}
        </p>
      ) : !read.data ? (
        <SkeletonRegion
          label="Loading artifact…"
          className="grid gap-2 px-(--inspector-inset) pt-3"
        >
          {['w-1/3', 'w-1/2', 'w-2/5'].map((width) => (
            <SkeletonLine key={width} className={width} />
          ))}
        </SkeletonRegion>
      ) : code ? (
        <InspectorBody className="px-(--inspector-inset)">
          <CodeBlock text={source ?? ''} language={LANGUAGE[artifact.type]} wrapped />
        </InspectorBody>
      ) : slides && slide !== undefined ? (
        <DeckView
          key={version}
          title={artifact.title}
          slides={slides}
          at={slide}
          onAt={setAt}
          editing={editing}
          frame={frame}
        />
      ) : component ? (
        // The frame stays mounted while Tweaks opens and shuts beside it.
        <div className="relative flex min-h-0 flex-1">
          <ArtifactFrame
            key={version}
            type={artifact.type}
            title={artifact.title}
            source={read.data.compiled ?? read.data.content}
            frame={frame}
            className="min-h-0 min-w-0 flex-1 border-0"
            scheme={tweaks.scheme === 'auto' ? undefined : tweaks.scheme}
          />
          {tweaksShown && <TweaksPanel tweaks={tweaks} />}
        </div>
      ) : (
        <ArtifactFrame
          key={`${version}:${editing}`}
          type={artifact.type}
          title={artifact.title}
          source={read.data.compiled ?? read.data.content}
          editing={editing}
          frame={frame}
        />
      )}
      {presenting && slides && read.data && (
        <Presentation
          title={artifact.title}
          source={read.data.content}
          start={slide ?? 0}
          onClose={() => setPresenting(false)}
        />
      )}
    </>
  );
}
