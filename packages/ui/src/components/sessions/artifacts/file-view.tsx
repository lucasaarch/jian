'use client';

import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { useMemo } from 'react';
import { HoverTip, iconButton, SkeletonLine, SkeletonRegion } from '../../../kit';
import type { SessionArtifact } from '../../../lib/api';
import { keys } from '../../../lib/query/keys';
import type { LoadedMedia } from '../media';
import { MediaReader, RENDERED, textView } from '../reader';
import { download, fileOf } from './source';
import type { ArtifactsApi } from './use-artifacts';

type ArtifactFile = NonNullable<SessionArtifact['file']>;

/** Whether a file is drawn as it reads, with its source one click away: a page, a document. */
export const fileHasSource = (file: ArtifactFile) => RENDERED.has(file.mimeType);

/**
 * The bytes of a file's version, which are media of the conversation and read as media is. A
 * version's file never changes, so it is read once. The key is its own: a message that carries
 * the same attachment keeps it under the media's key in another shape (media.tsx).
 */
export function useArtifactFile(api: ArtifactsApi, profileId: string, file: ArtifactFile) {
  return useQuery({
    queryKey: [...keys.media(profileId, file.mediaId), 'artifact'],
    queryFn: () => api.media(profileId, file.mediaId),
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/**
 * A file Artifact in the Inspector, read with the reader of its format (reader.tsx), the same
 * one an attachment opens in. Nothing of a file runs, so it needs no sealed frame.
 */
export function FileView({
  api,
  profileId,
  file,
  source,
}: {
  api: ArtifactsApi;
  profileId: string;
  file: ArtifactFile;
  /** A page's or a document's source instead of it drawn. */
  source: boolean;
}) {
  const read = useArtifactFile(api, profileId, file);
  const media = useMemo<LoadedMedia | undefined>(
    () =>
      read.data && {
        ...read.data,
        // The name the Artifact gives it: an attachment may have come with none.
        name: file.name,
        url: `data:${read.data.mimeType};base64,${read.data.data}`,
      },
    [read.data, file.name],
  );
  const text = useMemo(() => (media ? textView(media) : undefined), [media]);

  if (read.isError) {
    return (
      <p role="alert" className="px-(--inspector-inset) pt-3 text-sm text-muted">
        {read.error instanceof Error ? read.error.message : 'The file could not be read.'}
      </p>
    );
  }
  if (!media) {
    return (
      <SkeletonRegion label="Loading file…" className="grid gap-2 px-(--inspector-inset) pt-3">
        {['w-1/3', 'w-1/2', 'w-2/5'].map((width) => (
          <SkeletonLine key={width} className={width} />
        ))}
      </SkeletonRegion>
    );
  }

  return (
    // One track the size of the box, so a tall picture or page is fitted to it, not cropped.
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)] place-items-center px-(--inspector-inset) pb-3">
      <MediaReader media={media} text={text} source={source} dismiss={() => {}} />
    </div>
  );
}

/** Saves the file as it was given, under its own name. */
export function FileDownload({
  api,
  profileId,
  file,
}: {
  api: ArtifactsApi;
  profileId: string;
  file: ArtifactFile;
}) {
  const read = useArtifactFile(api, profileId, file);

  return (
    <HoverTip tip="Download" side="bottom" align="end">
      <button
        type="button"
        aria-label="Download"
        disabled={!read.data}
        className={iconButton}
        onClick={() => read.data && download(file.name, fileOf(read.data))}
      >
        <Download size={15} aria-hidden="true" />
      </button>
    </HoverTip>
  );
}
