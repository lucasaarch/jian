'use client';

import { useEffect, useState } from 'react';
import type { GatewayApi } from '../../lib/api';

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
      [...content.matchAll(/\[Attached media: ([0-9a-f-]{36})\]/g)].map((match) => match[1] ?? ''),
    ),
  ];
  return (
    <>
      {ids.map((id) => (
        <Attachment key={id} api={api} profileId={profileId} id={id} />
      ))}
    </>
  );
}

function Attachment({
  api,
  profileId,
  id,
}: {
  api: Pick<GatewayApi, 'media'>;
  profileId: string;
  id: string;
}) {
  const [media, setMedia] = useState<Awaited<ReturnType<GatewayApi['media']>>>();
  const [error, setError] = useState('');
  useEffect(() => {
    let stopped = false;
    void api
      .media(profileId, id)
      .then((value) => {
        if (!stopped) setMedia(value);
      })
      .catch(() => {
        if (!stopped) setError('Attachment unavailable.');
      });
    return () => {
      stopped = true;
    };
  }, [api.media, profileId, id]);
  if (error) return <p role="status">{error}</p>;
  if (!media) return <p role="status">Loading attachment…</p>;
  const url = `data:${media.mimeType};base64,${media.data}`;
  return (
    <div className="my-3 max-w-full">
      {media.mimeType.startsWith('image/') ? (
        // Native image preserves the authenticated data URL; no public image optimizer can read it.
        // biome-ignore lint/performance/noImgElement: Private attachment fetched through the authenticated API.
        <img
          src={url}
          alt="Conversation attachment"
          className="max-h-[500px] max-w-full rounded-lg object-contain"
        />
      ) : (
        <audio
          controls
          preload="metadata"
          src={url}
          aria-label="Conversation audio"
          className="max-w-full"
        >
          <track kind="captions" />
        </audio>
      )}
      <a
        href={url}
        download={`jian-${id}.${media.mimeType.split('/')[1]}`}
        className="text-sm underline"
      >
        Download
      </a>
    </div>
  );
}
