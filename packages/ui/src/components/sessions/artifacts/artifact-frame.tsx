'use client';

import {
  ARTIFACT_EDIT_MESSAGE,
  ARTIFACT_FRAME_MESSAGE,
  type ArtifactFrameType,
} from '@jian/contracts';
import { type CSSProperties, type RefObject, useEffect, useRef } from 'react';
import { gatewayConnection } from '../../../platform/gateway';

/**
 * One Artifact, drawn. What an agent wrote runs here, so the frame is sealed three ways:
 *
 * - `sandbox="allow-scripts"` and nothing more. Without `allow-same-origin` the frame's origin
 *   matches nothing: it has no cookie and no storage, and cannot read this panel or call the
 *   gateway as the owner. Never add a token to this list.
 * - It loads the gateway's empty frame for the type, which carries its own policy: nothing is
 *   fetched from anywhere, the gateway included. The frame's address holds no Artifact, so
 *   opening it needs no credential and gives nothing away.
 * - The source goes in as one message, once. The panel listens for nothing back: no message
 *   from a frame that draws is ever read, so an Artifact has no way to ask the panel for
 *   anything.
 *
 * `editing` loads the other frame of the type, the one the owner edits by hand in. It is as
 * sealed, and runs nothing of the Artifact. The panel reads one thing from it, and only when
 * the owner saves: the edited markup, asked for and checked in edit.ts.
 *
 * Mount it with a key per Artifact, version and way of showing it: a new source is a new frame.
 */
export function ArtifactFrame({
  type,
  title,
  source,
  editing = false,
  presenting = false,
  scale = 1,
  frame,
  className = 'min-h-0 w-full flex-1 border-0',
  style,
  lazy = false,
  onReady,
}: {
  type: ArtifactFrameType;
  title: string;
  /** What the frame runs: the source, a React component compiled, or one slide of a deck. */
  source: string;
  editing?: boolean;
  /**
   * A deck's player, the one its public link runs, already presenting (deck/presentation.tsx).
   * `source` is then the whole deck, and the frame says one thing back, which that file reads.
   */
  presenting?: boolean;
  /**
   * How far the panel scales the frame, as a slide's fixed canvas is. Only the editing frame is
   * told, to draw its bar of formatting at a size that reads.
   */
  scale?: number;
  /** The element, for the one who asks the editing frame for its markup. */
  frame?: RefObject<HTMLIFrameElement | null>;
  className?: string;
  style?: CSSProperties;
  /** Loaded only once it is near the screen, as one of many slides in a rail is. */
  lazy?: boolean;
  /**
   * Told once the source was handed over and the frame has had two frames to paint it, so a
   * caller can keep what was on screen until then and no blank page shows in between.
   */
  onReady?: () => void;
}) {
  const own = useRef<HTMLIFrameElement>(null);
  const element = frame ?? own;
  const handed = useRef(false);

  // The panel being resized changes the scale while a page is open for editing.
  useEffect(() => {
    if (!editing || !handed.current) return;
    element.current?.contentWindow?.postMessage({ [ARTIFACT_EDIT_MESSAGE]: { scale } }, '*');
  }, [editing, scale, element]);

  return (
    <iframe
      ref={element}
      title={title}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      {...(lazy ? { loading: 'lazy' as const } : {})}
      src={`${gatewayConnection().origin}/v1/artifact-frames/${type}${editing ? '?edit=1' : presenting ? '?present=1' : ''}`}
      className={className}
      style={style}
      onLoad={(event) => {
        // Only the first load is the gateway's frame. A page that loads again, or takes itself
        // somewhere else, is handed nothing.
        if (handed.current) return;
        handed.current = true;
        // A sealed frame's origin cannot be named, so the target is `*`. What is sent is only
        // the Artifact's own source.
        event.currentTarget.contentWindow?.postMessage(
          {
            [ARTIFACT_FRAME_MESSAGE]: source,
            ...(editing ? { [ARTIFACT_EDIT_MESSAGE]: { scale } } : {}),
          },
          '*',
        );
        if (onReady) requestAnimationFrame(() => requestAnimationFrame(onReady));
      }}
    />
  );
}
