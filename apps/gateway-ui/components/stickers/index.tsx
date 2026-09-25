'use client';

import { Power, Search, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Sticker } from '../../lib/api';
import type { SectionProps } from '../props';
import { Button, Confirm, Empty, SectionHeading } from '../ui';
import { Select } from '../ui/select';

type Order = 'most_sent' | 'most_seen' | 'newest';

const orders: Array<{ value: Order; label: string }> = [
  { value: 'most_sent', label: 'Most sent by the agent' },
  { value: 'most_seen', label: 'Most sent by people' },
  { value: 'newest', label: 'Newest' },
];

const sorted = (list: Sticker[], order: Order) =>
  [...list].sort((a, b) =>
    order === 'newest'
      ? b.createdAt.localeCompare(a.createdAt)
      : order === 'most_seen'
        ? b.seen - a.seen || b.uses - a.uses
        : b.uses - a.uses || b.seen - a.seen,
  );

const times = (count: number) => (count === 1 ? 'once' : `${count}×`);

/** One sticker, drawn once it is on screen, its tags a click away from filtering by them. */
function StickerTile({
  sticker,
  load,
  remove,
  filter,
}: {
  sticker: Sticker;
  load: (id: string) => Promise<string | undefined>;
  remove: () => void;
  filter: (tag: string) => void;
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
      <div className="sticker-tags">
        {sticker.tags.map((tag) => (
          <button type="button" key={tag} className="sticker-tag" onClick={() => filter(tag)}>
            {tag}
          </button>
        ))}
      </div>
      <small>
        Sent {sticker.uses ? times(sticker.uses) : 'never'} by the agent · {times(sticker.seen)} by
        people
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
 * The stickers the agent can send: every one people sent in its approved chats, kept once,
 * described and tagged by what it shows, and counted each time it is sent. Removing one keeps
 * the agent from ever sending it.
 */
export function Stickers({ profile, api, mutate, busy: saving }: SectionProps) {
  const [list, setList] = useState<Sticker[]>();
  const [removing, setRemoving] = useState<Sticker>();
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [order, setOrder] = useState<Order>('most_sent');

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

  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);

    return sorted(list ?? [], order).filter((sticker) => {
      const text = `${sticker.description ?? ''} ${sticker.tags.join(' ')}`.toLowerCase();

      return words.every((word) => text.includes(word));
    });
  }, [list, order, query]);

  return (
    <>
      <SectionHeading
        title="Stickers"
        description={`The stickers ${profile.name} can send. It keeps each one people send in approved chats, tags it by what it shows, and finds it by meaning.`}
        action={
          <Button
            variant={profile.useStickers ? 'secondary' : 'primary'}
            busy={saving}
            onClick={() =>
              void mutate(
                () =>
                  api.updateProfile(profile.id, {
                    expectedVersion: profile.version,
                    useStickers: !profile.useStickers,
                  }),
                profile.useStickers ? 'Stickers switched off.' : 'Stickers switched on.',
              )
            }
          >
            <Power size={16} />
            {profile.useStickers ? 'Disable stickers' : 'Enable stickers'}
          </Button>
        }
      />
      {!profile.useStickers && (
        <p className="note sticker-off" role="status">
          Stickers are off: nothing new is kept or described, and {profile.name} cannot send them.
          The collection below stays as it is.
        </p>
      )}
      {list?.length ? (
        <div className="sticker-toolbar">
          <label className="search-field">
            <Search size={16} aria-hidden="true" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search by tag or description"
              aria-label="Search stickers"
            />
          </label>
          <Select
            value={order}
            onValueChange={(value) => setOrder(value as Order)}
            options={orders}
            aria-label="Order"
          />
        </div>
      ) : null}
      {!list ? null : shown.length ? (
        <ul className="sticker-grid">
          {shown.map((sticker) => (
            <StickerTile
              key={sticker.id}
              sticker={sticker}
              load={load}
              remove={() => setRemoving(sticker)}
              filter={setQuery}
            />
          ))}
        </ul>
      ) : list.length ? (
        <Empty title="Nothing found">No sticker matches that search.</Empty>
      ) : (
        <Empty title="No stickers yet">
          When someone sends a sticker in a chat you approved, it is kept here for the agent to send
          back.
        </Empty>
      )}
      {removing && (
        <Confirm
          title="Remove this sticker?"
          description="The agent stops sending it, and it is not kept again when someone sends it anew."
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
