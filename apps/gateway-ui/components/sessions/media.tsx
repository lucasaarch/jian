'use client';

import { FileText } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { GatewayApi } from '../../lib/api';
import { AudioPlayer } from '../ui';
import { MediaViewer } from './viewer';

export type LoadedMedia = Awaited<ReturnType<GatewayApi['media']>> & { url: string };

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

/**
 * What a message carries, laid out as a messaging app does: files and voice notes stacked
 * first, then the pictures as one mosaic. Any picture or document opens in the viewer.
 */
export function MessageMedia({
  api,
  profileId,
  content,
}: {
  api: Pick<GatewayApi, 'media'>;
  profileId: string;
  content: string;
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
  const key = ids.join(',');
  const [items, setItems] = useState<Array<LoadedMedia | { id: string; failed: true }>>();
  const [open, setOpen] = useState<LoadedMedia>();

  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for the ids it joins.
  useEffect(() => {
    if (!ids.length) return;
    let stopped = false;

    void Promise.all(
      ids.map((id) =>
        api
          .media(profileId, id)
          .then((media) => ({ ...media, url: `data:${media.mimeType};base64,${media.data}` }))
          .catch(() => ({ id, failed: true as const })),
      ),
    ).then((loaded) => {
      if (!stopped) setItems(loaded);
    });

    return () => {
      stopped = true;
    };
  }, [api.media, profileId, key]);

  if (!ids.length) return null;
  if (!items) return <p className="media-note">Loading attachments…</p>;

  const loaded = items.filter((item): item is LoadedMedia => !('failed' in item));
  const images = loaded.filter((item) => item.mimeType.startsWith('image/'));
  const files = loaded.filter((item) => !item.mimeType.startsWith('image/'));
  const failed = items.length - loaded.length;
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
      {images.length > 0 && (
        <div className="mosaic" data-count={Math.min(images.length, MOSAIC_TILES)}>
          {images.slice(0, MOSAIC_TILES).map((media, index) => {
            const hidden = index === MOSAIC_TILES - 1 ? images.length - MOSAIC_TILES : 0;

            return (
              <button
                type="button"
                key={media.id}
                className="mosaic-tile"
                aria-label={
                  hidden > 0 ? `Open ${hidden + 1} more images` : `Open ${media.name ?? 'image'}`
                }
                onClick={() => setOpen(media)}
              >
                {/* biome-ignore lint/performance/noImgElement: Private attachment fetched through the authenticated API. */}
                <img src={media.url} alt="" />
                {hidden > 0 && <span className="mosaic-more">+{hidden}</span>}
              </button>
            );
          })}
        </div>
      )}
      {failed > 0 && (
        <p className="media-note">
          {failed === 1
            ? 'One attachment is unavailable.'
            : `${failed} attachments are unavailable.`}
        </p>
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
