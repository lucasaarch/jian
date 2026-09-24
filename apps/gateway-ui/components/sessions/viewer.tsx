'use client';

import { ChevronLeft, ChevronRight, Download, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { type LoadedMedia, nameOf } from './media';
import { ZoomableImage } from './zoom';

/** How long the viewer takes to fade out; the CSS animation runs for the same time. */
const CLOSING_MS = 160;

const decode = (data: string) =>
  new TextDecoder().decode(Uint8Array.from(atob(data), (char) => char.charCodeAt(0)));

/**
 * A PDF shown by the browser's own reader. It reads from a local blob address, released when
 * the document changes or the viewer closes.
 */
function Pdf({ media }: { media: LoadedMedia }) {
  const url = useMemo(
    () =>
      URL.createObjectURL(
        new Blob([Uint8Array.from(atob(media.data), (char) => char.charCodeAt(0))], {
          type: 'application/pdf',
        }),
      ),
    [media.data],
  );

  useEffect(() => () => URL.revokeObjectURL(url), [url]);

  return <iframe className="viewer-pdf" src={url} title={nameOf(media)} />;
}

/**
 * The attachments of one message, one at a time over the whole screen. The arrows and the
 * keyboard move between them; Escape, the close button and a click outside close it.
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
  // Plays the way out before the dialog goes; a second request while it plays changes nothing.
  const leave = () => {
    if (closing) return;
    setClosing(true);
    setTimeout(close, CLOSING_MS);
  };
  const media = items[index];
  const many = items.length > 1;
  const step = (by: number) => setIndex((current) => (current + by + items.length) % items.length);

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
        {media.mimeType.startsWith('image/') ? (
          <ZoomableImage
            key={media.id}
            src={media.url}
            alt={media.name ?? 'Image attachment'}
            dismiss={leave}
          />
        ) : media.mimeType === 'application/pdf' ? (
          <Pdf media={media} />
        ) : (
          <pre className="viewer-text">{decode(media.data)}</pre>
        )}
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
