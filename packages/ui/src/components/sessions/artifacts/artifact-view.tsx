'use client';

import { EDITABLE_ARTIFACT_TYPES } from '@jian/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Code, Eye, Pencil, Presentation as PresentIcon } from 'lucide-react';
import { type RefObject, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Action, HoverTip, iconButton, SkeletonLine, SkeletonRegion } from '../../../kit';
import type { SessionArtifact } from '../../../lib/api';
import { useGatewayMode } from '../../../lib/gateway-mode';
import { keys } from '../../../lib/query/keys';
import { useCrew } from '../../../lib/stores/crew';
import { CodeBlock } from '../../ui/code-block';
import { InspectorBar, InspectorBody } from '../inspector';
import { ArtifactFrame } from './artifact-frame';
import { ArtifactHistory } from './artifact-history';
import { ArtifactOptions } from './artifact-options';
import { ArtifactSharing } from './artifact-sharing';
import { DeckDownload } from './deck/deck-download';
import { DeckView } from './deck/deck-view';
import { Presentation } from './deck/presentation';
import { collectEdit } from './edit';
import { FileDownload, FileView, fileHasSource } from './file-view';
import { fileName, LANGUAGE } from './source';
import { type ArtifactsApi, useArtifactVersion } from './use-artifacts';

/**
 * One Artifact in the Inspector: drawn in its sealed frame, or as its source, at the version
 * the owner picks from its history. With none picked it is the latest, and follows the agent's
 * updates; an older one in view is named beside the title. Mount it with the Artifact's id as
 * its key, so another one starts drawn and at its latest.
 *
 * A deck is read as slides, never as code: a slide's markup is still copied from the options,
 * and the deck is taken away as a file from a menu of its own (deck/deck-download.tsx).
 *
 * A file is read with the reader of its format and no frame (file-view.tsx): it has versions
 * and a link like the rest, is downloaded as it was given, and is never edited here.
 *
 * A page and a deck's slide can be edited by hand: Edit opens the version in view in the frame
 * that edits (artifact-frame.tsx), and Save asks that frame for the markup and hands it to the
 * gateway, which keeps it as a new version of the owner's. The frame saves nothing itself.
 */
export function ArtifactView({
  api,
  profileId,
  artifact,
  closer,
}: {
  api: ArtifactsApi;
  profileId: string;
  artifact: SessionArtifact;
  closer: RefObject<HTMLButtonElement | null>;
}) {
  const client = useQueryClient();
  const [picked, setPicked] = useState<number>();
  const [code, setCode] = useState(false);
  // The slide of a deck in view, counted from 0.
  const [at, setAt] = useState(0);
  // The version open for editing. It is held while it is: an update of the agent's meanwhile
  // must not take the page from under the owner's hands.
  const [editing, setEditing] = useState<number>();
  const [saving, setSaving] = useState(false);
  const [presenting, setPresenting] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  // Only a server gateway makes one public, or draws a deck into a file, so nothing else offers
  // either; until the gateway says which it is, neither does this.
  const server = useGatewayMode() === 'server';
  const version = editing ?? picked ?? artifact.version;
  const read = useArtifactVersion(api, profileId, artifact.sessionId, artifact.id, version);
  const slides = artifact.type === 'deck' ? read.data?.slides : undefined;
  const slide = slides ? Math.min(at, slides.length - 1) : undefined;
  // What is read as code, copied and downloaded: the source as written, or the slide in view.
  const source = slide === undefined ? read.data?.content : slides?.[slide];
  const editable = EDITABLE_ARTIFACT_TYPES.includes(artifact.type);
  // The file of the version in view, once that version is read.
  const file = artifact.type === 'file' ? read.data?.file : undefined;
  // What has a drawing and a source to switch between: not a deck, and of files only a page
  // or a document.
  const sourced = artifact.type === 'file' ? file && fileHasSource(file) : artifact.type !== 'deck';

  const save = async () => {
    if (editing === undefined || saving) return;
    setSaving(true);
    try {
      const html = await collectEdit(frame.current);
      if (html === null) {
        toast('Nothing was changed.');
      } else {
        const next = await api.editSessionArtifact(profileId, artifact.sessionId, artifact.id, {
          version: editing,
          content: html,
          ...(slide === undefined ? {} : { slide: slide + 1 }),
        });
        client.setQueryData<SessionArtifact[]>(
          keys.sessionArtifacts(profileId, artifact.sessionId),
          (all) => all?.map((item) => (item.id === next.id ? next : item)),
        );
        toast.success(`Saved as version ${next.version}.`);
      }
      // Back to the latest, which is now the one just saved.
      setPicked(undefined);
      setEditing(undefined);
    } catch (error) {
      // The edit stays open: nothing typed is lost to a save that failed.
      toast.error(error instanceof Error ? error.message : 'The edit could not be saved.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <InspectorBar
        closer={closer}
        options={
          editing !== undefined ? (
            <>
              <Action
                size="small"
                tone="quiet"
                disabled={saving}
                onClick={() => setEditing(undefined)}
              >
                Cancel
              </Action>
              <Action size="small" tone="primary" busy={saving} onClick={() => void save()}>
                Save
              </Action>
            </>
          ) : (
            <>
              {sourced && (
                <HoverTip tip={code ? 'Show it drawn' : 'View code'} side="bottom" align="end">
                  <button
                    type="button"
                    aria-label="View code"
                    aria-pressed={code}
                    className={iconButton}
                    onClick={() => setCode(!code)}
                  >
                    {code ? (
                      <Eye size={15} aria-hidden="true" />
                    ) : (
                      <Code size={15} aria-hidden="true" />
                    )}
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
              {editable && (
                <HoverTip
                  tip={slide === undefined ? 'Edit the text' : 'Edit this slide’s text'}
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
                      setEditing(version);
                    }}
                  >
                    <Pencil size={14} aria-hidden="true" />
                  </button>
                </HoverTip>
              )}
              <ArtifactHistory
                latest={artifact.version}
                version={version}
                onPick={(next) => setPicked(next === artifact.version ? undefined : next)}
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
              ) : artifact.type === 'file' ? (
                file && <FileDownload api={api} profileId={profileId} file={file} />
              ) : (
                <ArtifactOptions source={source} file={fileName(artifact, version)} what="Source" />
              )}
            </>
          )
        }
      >
        <HoverTip tip="All artifacts" hoverOnly side="bottom">
          <button
            type="button"
            aria-label="All artifacts"
            className={iconButton}
            onClick={() => useCrew.getState().showArtifacts()}
          >
            <ArrowLeft size={15} aria-hidden="true" />
          </button>
        </HoverTip>
        <h2 className="min-w-0 truncate text-[13px] font-medium text-ink">{artifact.title}</h2>
        {version !== artifact.version && (
          <span className="shrink-0 text-xs text-muted tabular-nums">v{version}</span>
        )}
      </InspectorBar>

      {read.isError ? (
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
      ) : artifact.type === 'file' ? (
        file && <FileView key={version} api={api} profileId={profileId} file={file} source={code} />
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
          editing={editing !== undefined}
          frame={frame}
        />
      ) : (
        <ArtifactFrame
          key={`${version}:${editing !== undefined}`}
          type={artifact.type}
          title={artifact.title}
          source={read.data.compiled ?? read.data.content}
          editing={editing !== undefined}
          frame={frame}
        />
      )}
      {presenting && slides && (
        <Presentation
          title={artifact.title}
          slides={slides}
          at={slide ?? 0}
          onAt={setAt}
          onClose={() => setPresenting(false)}
        />
      )}
    </>
  );
}
