'use client';

import { ChevronLeft, ChevronRight, CodeXml, Download, Eye, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { type LoadedMedia, nameOf } from './media';
import { MediaReader, RENDERED, textView } from './reader';

/** How long the viewer takes to fade out; the CSS animation runs for the same time. */
const CLOSING_MS = 160;

/**
 * The attachments of one message, one at a time over the whole screen, each read as its format
 * is (reader.tsx). The arrows and the keyboard move between them; Escape, the close button and
 * a click outside close it.
 */
export function MediaViewer({
  items,
  start,
  close,
}: {
  items: LoadedMedia[];
  start: number;
  close: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [index, setIndex] = useState(Math.max(start, 0));
  const [closing, setClosing] = useState(false);
  const [source, setSource] = useState(false);
  // Plays the way out before the dialog goes; a second request while it plays changes nothing.
  const leave = () => {
    if (closing) return;
    setClosing(true);
    setTimeout(close, CLOSING_MS);
  };
  const media = items[index];
  const many = items.length > 1;
  const step = (by: number) => {
    setIndex((current) => (current + by + items.length) % items.length);
    setSource(false);
  };
  const text = useMemo(() => (media ? textView(media) : undefined), [media]);

  useEffect(() => {
    ref.current?.showModal();

    return () => ref.current?.close();
  }, []);

  if (!media) return null;

  return (
    <dialog
      ref={ref}
      className="viewer"
      data-closing={closing}
      aria-label={nameOf(media)}
      onCancel={(event) => {
        event.preventDefault();
        leave();
      }}
      onKeyDown={(event) => {
        if (many && event.key === 'ArrowRight') step(1);
        if (many && event.key === 'ArrowLeft') step(-1);
      }}
      onClick={(event) => {
        // Only the empty space around the content is hit directly: that is a click outside it.
        const target = event.target as HTMLElement;

        if (target === event.currentTarget || target.classList.contains('viewer-stage')) leave();
      }}
    >
      <header>
        <strong>
          {media.mimeType.startsWith('image/') ? (media.name ?? 'Image') : nameOf(media)}
        </strong>
        {many && (
          <span>
            {index + 1} / {items.length}
          </span>
        )}
        {text && RENDERED.has(media.mimeType) && (
          <button
            type="button"
            className="viewer-button"
            aria-label={source ? 'Show preview' : 'Show source'}
            aria-pressed={source}
            onClick={() => setSource(!source)}
          >
            {source ? <Eye size={18} /> : <CodeXml size={18} />}
          </button>
        )}
        <a
          className="viewer-button"
          href={media.url}
          download={nameOf(media)}
          aria-label="Download"
        >
          <Download size={18} />
        </a>
        <button type="button" className="viewer-button" aria-label="Close" onClick={leave}>
          <X size={20} />
        </button>
      </header>
      <div className="viewer-stage">
        <MediaReader media={media} text={text} source={source} dismiss={leave} />
      </div>
      {many && (
        <>
          <button
            type="button"
            className="viewer-button viewer-previous"
            aria-label="Previous"
            onClick={() => step(-1)}
          >
            <ChevronLeft size={22} />
          </button>
          <button
            type="button"
            className="viewer-button viewer-next"
            aria-label="Next"
            onClick={() => step(1)}
          >
            <ChevronRight size={22} />
          </button>
        </>
      )}
    </dialog>
  );
}
