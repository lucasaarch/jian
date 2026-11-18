'use client';

import { Download } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { AudioPlayer } from '../ui';
import { kindNames, type LoadedMedia, nameOf, readsAsText, size } from './media';
import { Code, HtmlPage, languageOf, MarkdownPage, textOf } from './preview';
import { ZoomableImage } from './zoom';

/** Documents drawn as they read, with their source one click away. */
export const RENDERED = new Set(['text/html', 'text/markdown']);

/**
 * What a document is shown as: text formats, and files of an unnamed type whose name says
 * code, as text; anything whose bytes turn out not to be text, as a download.
 */
export function textView(media: LoadedMedia) {
  const language = languageOf(media.mimeType, media.name);
  const declared = readsAsText(media.mimeType);

  if (!declared && !(media.mimeType === 'application/octet-stream' && language)) return undefined;

  const text = textOf(media.data, declared);

  return text === undefined ? undefined : { text, language };
}

/**
 * A PDF shown by the browser's own reader. It reads from a local blob address, released when
 * the document changes or its reader goes.
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
 * One file, read as its format is: a picture zoomed, a PDF in the browser's reader, a video and
 * a sound played, an HTML or Markdown document laid out, any other text as code, and what has
 * no reader as a card to download. It fills the box it is put in, which the full-screen viewer
 * and the Inspector's Artifacts tab each give it.
 *
 * Nothing of the file runs: a page is drawn in a frame with no scripts (preview.tsx), and
 * text is set as text.
 */
export function MediaReader({
  media,
  text,
  source,
  dismiss,
}: {
  media: LoadedMedia;
  /** `textView(media)`, which whoever holds the source toggle already made. */
  text: ReturnType<typeof textView>;
  /** A rendered document's source instead of the document. */
  source: boolean;
  /** Called on a click beside a picture, which reads as a click outside it. */
  dismiss: () => void;
}) {
  return media.mimeType.startsWith('image/') ? (
    <ZoomableImage
      key={media.id}
      src={media.url}
      alt={media.name ?? 'Image attachment'}
      dismiss={dismiss}
    />
  ) : media.mimeType === 'application/pdf' ? (
    <Pdf media={media} />
  ) : media.mimeType.startsWith('video/') ? (
    // biome-ignore lint/a11y/useMediaCaption: A file someone sent; it has no captions to offer.
    <video className="viewer-video" src={media.url} controls />
  ) : media.mimeType.startsWith('audio/') ? (
    <AudioPlayer src={media.url} label={media.name ?? 'audio'} />
  ) : text && !source && media.mimeType === 'text/html' ? (
    <HtmlPage key={media.id} text={text.text} title={nameOf(media)} />
  ) : text && !source && media.mimeType === 'text/markdown' ? (
    <MarkdownPage key={media.id} text={text.text} />
  ) : text ? (
    <Code key={media.id} text={text.text} language={text.language} />
  ) : (
    <div className="viewer-file">
      <strong>{nameOf(media)}</strong>
      <span>
        {kindNames[media.mimeType] ?? media.mimeType} · {size(media.bytes)}
      </span>
      <p>No preview for this format.</p>
      <a
        className="inline-flex h-9 items-center gap-2 rounded-full bg-accent px-4 text-sm font-medium text-on-accent shadow-sm transition-colors hover:bg-accent-hover"
        href={media.url}
        download={nameOf(media)}
      >
        <Download size={16} />
        Download
      </a>
    </div>
  );
}
