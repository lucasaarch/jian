'use client';

import { useQueries } from '@tanstack/react-query';
import { FileText } from 'lucide-react';
import { useState } from 'react';
import { keys } from '@/lib/query/keys';
import type { GatewayApi } from '../../lib/api';
import { AudioPlayer } from '../ui';
import { RefineFrame } from '../ui/refine-frame';
import { MediaViewer } from './viewer';

export type LoadedMedia = Awaited<ReturnType<GatewayApi['media']>> & {
  url: string;
  /** A picture's own size in px, when it could be read. */
  width?: number;
  height?: number;
};

export const size = (bytes: number) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${Math.round(bytes / 1024)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** What a document is called when it came without a name, by its type. */
export const kindNames: Record<string, string> = {
  'application/pdf': 'PDF',
  'text/markdown': 'Markdown',
  'text/csv': 'CSV',
  'application/json': 'JSON',
  'text/plain': 'Text',
  'text/html': 'HTML',
  'application/xml': 'XML',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Excel',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PowerPoint',
  'application/vnd.oasis.opendocument.text': 'OpenDocument text',
  'application/vnd.oasis.opendocument.spreadsheet': 'OpenDocument spreadsheet',
  'application/vnd.oasis.opendocument.presentation': 'OpenDocument presentation',
  'application/msword': 'Word',
  'application/vnd.ms-excel': 'Excel',
  'application/vnd.ms-powerpoint': 'PowerPoint',
  'application/rtf': 'Rich text',
  'application/zip': 'ZIP archive',
  'video/mp4': 'Video',
  'video/quicktime': 'Video',
  'video/webm': 'Video',
  'application/octet-stream': 'File',
};

/** Shown as text in the viewer; every other document is offered as a download. */
export const readsAsText = (mimeType: string) =>
  mimeType.startsWith('text/') || mimeType === 'application/json' || mimeType === 'application/xml';

export const nameOf = (media: LoadedMedia) =>
  media.name ?? `${kindNames[media.mimeType] ?? 'File'} document`;

/** How many pictures a mosaic shows before the last tile counts the rest. */
const MOSAIC_TILES = 4;
/** A picture alone fits this square, in px, at its own shape. */
const ALONE = 320;

type Fetched = LoadedMedia | { id: string; failed: true };

/** A picture's own size, read once with it, so its frame takes its shape before it shows. */
function measured(media: LoadedMedia): Promise<LoadedMedia> {
  if (!media.mimeType.startsWith('image/')) return Promise.resolve(media);

  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () =>
      resolve({ ...media, width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => resolve(media);
    image.src = media.url;
  });
}

/** A box of this shape that fits ALONE square: as wide as it can be, no taller than wide. */
function fitted(width: number, height: number) {
  return {
    aspectRatio: `${width} / ${height}`,
    width: Math.round(Math.min(ALONE, (ALONE * width) / height)),
  };
}

/** The frame of a picture being drawn, in the shape it was asked for ("16:9"). */
export function drawnBox(aspect = '1:1') {
  const [width = 1, height = 1] = aspect.split(':').map(Number);
  return fitted(width, height);
}

/**
 * The box of a picture shown alone: its own shape once it is here, and before that the shape
 * it was drawn in, if it was, so the frame does not change size when it arrives.
 */
function aloneBox(media?: LoadedMedia, drawn?: string) {
  if (!media?.width || !media.height) return drawn ? drawnBox(drawn) : fitted(4, 3);

  const box = fitted(media.width, media.height);
  return { ...box, width: Math.min(box.width, media.width) };
}

/**
 * What a message carries, laid out as a messaging app does: files and voice notes stacked
 * first, then the pictures as one mosaic. Any picture or document opens in the viewer. Until an
 * attachment is here its tile is a frame at work, and a picture resolves into that same frame.
 */
export function MessageMedia({
  api,
  profileId,
  content,
  drawn,
}: {
  api: Pick<GatewayApi, 'media'>;
  profileId: string;
  content: string;
  /** The shape of the picture the agent drew for this message, while it loads ("16:9"). */
  drawn?: string;
}) {
  const ids = [
    ...new Set(
      // A file posted in a group but not to the agent is noted with its id; it is still there.
      [
        ...content.matchAll(
          /\[(?:Attached media: |File not opened, it was not sent to you: [^\]]*?media ID )([0-9a-f-]{36})/g,
        ),
      ].map((match) => match[1] ?? ''),
    ),
  ];
  const [open, setOpen] = useState<LoadedMedia>();
  // An attachment never changes once stored, so each is read once and kept for the visit; one
  // that fails stays a failure until its tile is asked to try again.
  const results = useQueries({
    queries: ids.map((id) => ({
      queryKey: keys.media(profileId, id),
      queryFn: (): Promise<Fetched> =>
        api
          .media(profileId, id)
          .then((media) =>
            measured({ ...media, url: `data:${media.mimeType};base64,${media.data}` }),
          )
          .catch(() => ({ id, failed: true as const })),
      staleTime: Number.POSITIVE_INFINITY,
    })),
  });

  if (!ids.length) return null;

  const entries = ids.map((id, index) => ({
    id,
    item: results[index]?.data,
    retry: () => void results[index]?.refetch(),
  }));
  const loaded = entries.flatMap(({ item }) => (item && !('failed' in item) ? [item] : []));
  const images = loaded.filter((item) => item.mimeType.startsWith('image/'));
  const files = loaded.filter((item) => !item.mimeType.startsWith('image/'));
  // In the order they were sent, so a tile keeps its place from loading to loaded.
  const tiles = entries.filter(
    ({ item }) => !item || 'failed' in item || item.mimeType.startsWith('image/'),
  );
  const shown = tiles.slice(0, MOSAIC_TILES);
  const viewable = [...files.filter((item) => !item.mimeType.startsWith('audio/')), ...images];

  return (
    <div className="message-media">
      {files.map((media) =>
        media.mimeType.startsWith('audio/') ? (
          <AudioPlayer key={media.id} src={media.url} label={media.name ?? 'audio'} />
        ) : (
          <button type="button" key={media.id} className="file-card" onClick={() => setOpen(media)}>
            <span className="file-icon" aria-hidden="true">
              <FileText size={18} />
            </span>
            <span className="file-text">
              <strong>{nameOf(media)}</strong>
              <small>
                {kindNames[media.mimeType] ?? media.mimeType} · {size(media.bytes)}
              </small>
            </span>
          </button>
        ),
      )}
      {shown.length > 0 && (
        <div className="mosaic" data-count={shown.length}>
          {shown.map(({ id, item, retry }, index) => {
            const media = item && !('failed' in item) ? item : undefined;
            const hidden = index === MOSAIC_TILES - 1 ? tiles.length - MOSAIC_TILES : 0;
            const status = !item ? 'generating' : media ? 'complete' : 'error';

            return (
              <div key={id} className="mosaic-tile">
                <RefineFrame
                  status={status}
                  fill={shown.length > 1}
                  {...(shown.length === 1 ? aloneBox(media, drawn) : {})}
                  labels={{ generating: 'Loading', error: 'Unavailable' }}
                  onRetry={retry}
                >
                  {/* biome-ignore lint/performance/noImgElement: Private attachment fetched through the authenticated API. */}
                  {media && <img src={media.url} alt="" />}
                </RefineFrame>
                {media && (
                  <button
                    type="button"
                    className="mosaic-open"
                    aria-label={
                      hidden > 0
                        ? `Open ${hidden + 1} more images`
                        : `Open ${media.name ?? 'image'}`
                    }
                    onClick={() => setOpen(media)}
                  >
                    {hidden > 0 && <span className="mosaic-more">+{hidden}</span>}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      {open && (
        <MediaViewer
          items={viewable}
          start={viewable.indexOf(open)}
          close={() => setOpen(undefined)}
        />
      )}
    </div>
  );
}
