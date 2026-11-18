'use client';

import { useEffect, useRef, useState } from 'react';
import { SlideFrame } from '../../components/sessions/artifacts/deck/slide-frame';
import { useArtifactFile } from '../../components/sessions/artifacts/file-view';
import { KIND_TINT, KindIcon } from '../../components/sessions/artifacts/kind';
import {
  type ArtifactsApi,
  useArtifactVersion,
} from '../../components/sessions/artifacts/use-artifacts';
import type { ProfileArtifact } from '../../lib/api';

/**
 * The largest picture read for a card, in bytes. A picture's bytes come whole, in base64, so a
 * page of large ones would be read in full for a row of thumbnails; a larger one keeps its
 * kind's picture instead.
 */
const PICTURE_BYTES = 2 * 1024 * 1024;

/** How far past the screen's edge a card starts to read its picture, so it is there on arrival. */
const AHEAD = '200px';

type Shown = { api: ArtifactsApi; profileId: string; artifact: ProfileArtifact };

/**
 * Whether the box has come near the screen, once and for good: what a card reads for its
 * picture is asked for only then, not for every card of a long page. A host with no way to
 * tell takes every box as seen.
 */
function useSeen() {
  const box = useRef<HTMLDivElement>(null);
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === 'undefined');

  useEffect(() => {
    const element = box.current;
    if (seen || !element) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setSeen(true);
      },
      { rootMargin: AHEAD },
    );

    observer.observe(element);
    return () => observer.disconnect();
  }, [seen]);

  return [box, seen] as const;
}

/** What stands for one with no picture of its own: its kind's icon on its kind's tint. */
function KindPicture({ artifact }: { artifact: ProfileArtifact }) {
  return (
    <div
      data-thumbnail="kind"
      className={`grid size-full place-items-center ${KIND_TINT[artifact.type]}`}
    >
      <KindIcon artifact={artifact} size={28} className="" />
    </div>
  );
}

/**
 * A deck's first slide, drawn small in the same sealed frame as any slide. It is looked at, not
 * used, so nothing in it takes a click or a key; the filter changes no colour, it makes the
 * scaled frame draw as one picture before the card's corners cut it (deck/slide-rail.tsx).
 */
function FirstSlide({ api, profileId, artifact }: Shown) {
  const read = useArtifactVersion(
    api,
    profileId,
    artifact.sessionId,
    artifact.id,
    artifact.version,
  );
  const first = read.data?.slides?.[0];

  if (!first) return <KindPicture artifact={artifact} />;

  return (
    <div inert data-thumbnail="slide" className="grid size-full [filter:opacity(1)]">
      <SlideFrame
        title={`${artifact.title}, first slide`}
        source={first}
        lazy
        className="size-full"
      />
    </div>
  );
}

function Picture({
  api,
  profileId,
  artifact,
  file,
}: Shown & { file: NonNullable<ProfileArtifact['file']> }) {
  const read = useArtifactFile(api, profileId, file);

  if (!read.data) return <KindPicture artifact={artifact} />;

  return (
    // Drawn as a picture, never as a document: an SVG file's scripts do not run in an image.
    <img
      alt=""
      data-thumbnail="picture"
      src={`data:${read.data.mimeType};base64,${read.data.data}`}
      className="size-full object-cover"
    />
  );
}

/**
 * The picture at the head of a card. A real one where it is cheap to draw: a deck's first slide,
 * a picture file. Everything else, a page that would have to run among them, is its kind's icon
 * on its kind's tint, and so is what has not come near the screen yet. It fills the box it is
 * given.
 */
export function ArtifactThumbnail({ api, profileId, artifact }: Shown) {
  const [box, seen] = useSeen();
  const file = artifact.type === 'file' ? artifact.file : undefined;
  const picture = file?.mimeType.startsWith('image/') && file.bytes <= PICTURE_BYTES ? file : null;

  return (
    <div ref={box} className="size-full">
      {seen && artifact.type === 'deck' ? (
        <FirstSlide api={api} profileId={profileId} artifact={artifact} />
      ) : seen && picture ? (
        <Picture api={api} profileId={profileId} artifact={artifact} file={picture} />
      ) : (
        <KindPicture artifact={artifact} />
      )}
    </div>
  );
}
