'use client';

import { ARTIFACT_FRAME_MESSAGE } from '@jian/contracts';
import { useRef } from 'react';
import type { SessionArtifact } from '../../../lib/api';
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
 *   from a frame is ever read, so an Artifact has no way to ask the panel for anything.
 *
 * Mount it with a key per Artifact and version: a new source is a new frame.
 */
export function ArtifactFrame({
  type,
  title,
  source,
}: {
  type: SessionArtifact['type'];
  title: string;
  /** What the frame runs: the source, or a React component compiled by the gateway. */
  source: string;
}) {
  const handed = useRef(false);

  return (
    <iframe
      title={title}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      src={`${gatewayConnection().origin}/v1/artifact-frames/${type}`}
      className="min-h-0 w-full flex-1 border-0"
      onLoad={(event) => {
        // Only the first load is the gateway's frame. A page that loads again, or takes itself
        // somewhere else, is handed nothing.
        if (handed.current) return;
        handed.current = true;
        // A sealed frame's origin cannot be named, so the target is `*`. What is sent is only
        // the Artifact's own source.
        event.currentTarget.contentWindow?.postMessage({ [ARTIFACT_FRAME_MESSAGE]: source }, '*');
      }}
    />
  );
}
