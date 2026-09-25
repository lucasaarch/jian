'use client';

import { Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { Sticker } from '../../lib/api';
import type { SectionProps } from '../props';
import { Confirm, Empty, SectionHeading } from '../ui';

/** One sticker, drawn from the collection once it is on screen. */
function StickerTile({
  sticker,
  load,
  remove,
}: {
  sticker: Sticker;
  load: (id: string) => Promise<string | undefined>;
  remove: () => void;
}) {
  const [src, setSrc] = useState<string>();

  useEffect(() => {
    let active = true;

    void load(sticker.id).then((url) => {
      if (active) setSrc(url);
    });

    return () => {
      active = false;
    };
  }, [load, sticker.id]);

  return (
    <li className="sticker-tile">
      <div className="sticker-image">
        {/* biome-ignore lint/performance/noImgElement: Private image fetched through the authenticated API. */}
        {src && <img src={src} alt={sticker.description ?? 'Sticker'} />}
      </div>
      <p>{sticker.description ?? 'Not described yet'}</p>
      <small>
        {sticker.uses === 0
          ? 'Not sent yet'
          : sticker.uses === 1
            ? 'Sent once'
            : `Sent ${sticker.uses} times`}
      </small>
      <button
        type="button"
        className="icon-button sticker-remove"
        aria-label={`Remove ${sticker.description ?? 'this sticker'}`}
        onClick={remove}
      >
        <Trash2 size={15} />
      </button>
    </li>
  );
}

/**
 * The stickers the agent can send: every one people sent in its approved chats, kept once and
 * described by what it shows. Removing one keeps the agent from ever sending it.
 */
export function Stickers({ profile, api }: SectionProps) {
  const [list, setList] = useState<Sticker[]>();
  const [removing, setRemoving] = useState<Sticker>();
  const [busy, setBusy] = useState(false);

  const read = useCallback(
    () =>
      api
        .stickers(profile.id)
        .then(setList)
        .catch(() => setList([])),
    [api, profile.id],
  );
  const load = useCallback(
    (id: string) =>
      api
        .sticker(profile.id, id)
        .then((sticker) => `data:${sticker.mimeType};base64,${sticker.data}`)
        .catch(() => undefined),
    [api, profile.id],
  );

  useEffect(() => {
    void read();
  }, [read]);

  return (
    <>
      <SectionHeading
        title="Stickers"
        description={`The stickers ${profile.name} can send. It keeps each one people send in approved chats, and finds them by what they show.`}
      />
      {!list ? null : list.length ? (
        <ul className="sticker-grid">
          {list.map((sticker) => (
            <StickerTile
              key={sticker.id}
              sticker={sticker}
              load={load}
              remove={() => setRemoving(sticker)}
            />
          ))}
        </ul>
      ) : (
        <Empty title="No stickers yet">
          When someone sends a sticker in a chat you approved, it is kept here for the agent to send
          back.
        </Empty>
      )}
      {removing && (
        <Confirm
          title="Remove this sticker?"
          description="The agent stops sending it. If someone sends it again, it comes back."
          busy={busy}
          close={() => setRemoving(undefined)}
          confirm={async () => {
            setBusy(true);
            try {
              await api.forgetSticker(profile.id, removing.id);
              await read();
              setRemoving(undefined);
            } finally {
              setBusy(false);
            }
          }}
        />
      )}
    </>
  );
}
