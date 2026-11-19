'use client';

import { ARTIFACT_EDIT_MESSAGE, SESSION_ARTIFACT_MAX } from '@jian/contracts';
import { ImagePlus, Type } from 'lucide-react';
import { type RefObject, useRef, useState } from 'react';
import { toast } from 'sonner';
import { HoverTip, iconButton } from '../../../../kit';
import { type Picture, pictureFor } from './picture';

/** Room a slide keeps for what the owner types after the picture, in characters. */
const ROOM_KEPT = 8_000;

/**
 * What builds on the slide open for editing, in the bar beside Done: a text box, and a picture
 * from a file. Each is handed to the editing frame as data (`insert`, ARTIFACT_EDIT_MESSAGE),
 * which places it; the owner then moves, sizes and deletes it there. The picture is read and
 * made small enough here, so the frame never loads anything.
 */
export function SlideBuildTools({
  frame,
  used,
}: {
  frame: RefObject<HTMLIFrameElement | null>;
  /** How much of a slide's room its markup already takes, in characters. */
  used: number;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [reading, setReading] = useState(false);
  // A sealed frame's origin cannot be named, so the target is `*`. What is sent is only what
  // the owner asked to place.
  const insert = (what: { text: true } | Picture) =>
    frame.current?.contentWindow?.postMessage({ [ARTIFACT_EDIT_MESSAGE]: { insert: what } }, '*');

  const picked = async (file: File | undefined) => {
    if (!file) return;
    setReading(true);
    try {
      insert(await pictureFor(file, Math.max(0, SESSION_ARTIFACT_MAX - used - ROOM_KEPT)));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The picture could not be added.');
    } finally {
      setReading(false);
    }
  };

  return (
    <>
      <HoverTip tip="Add a text box" side="bottom" align="end">
        <button
          type="button"
          aria-label="Add a text box"
          className={iconButton}
          onClick={() => insert({ text: true })}
        >
          <Type size={15} aria-hidden="true" />
        </button>
      </HoverTip>
      <HoverTip tip="Add a picture" side="bottom" align="end">
        <button
          type="button"
          aria-label="Add a picture"
          aria-busy={reading}
          disabled={reading}
          className={iconButton}
          onClick={() => input.current?.click()}
        >
          <ImagePlus size={15} aria-hidden="true" />
        </button>
      </HoverTip>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml,image/avif"
        hidden
        onChange={(event) => {
          void picked(event.target.files?.[0]);
          // The same picture chosen again is still a choice.
          event.target.value = '';
        }}
      />
    </>
  );
}
