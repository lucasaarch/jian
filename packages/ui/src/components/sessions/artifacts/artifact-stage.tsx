'use client';

import { type ComponentProps, useState } from 'react';
import { SkeletonLine, SkeletonRegion } from '../../../kit';
import { ArtifactFrame } from './artifact-frame';

/** What stands where an Artifact is about to be: the lines its view shows while it is read. */
export function ArtifactSkeleton({ className = '' }: { className?: string }) {
  return (
    <SkeletonRegion
      label="Loading artifact…"
      className={`grid content-start gap-2 px-(--inspector-inset) pt-3 ${className}`}
    >
      {['w-1/3', 'w-1/2', 'w-2/5'].map((width) => (
        <SkeletonLine key={width} className={width} />
      ))}
    </SkeletonRegion>
  );
}

/**
 * An Artifact's frame with the skeleton over it until it has drawn (artifact-frame.tsx keeps
 * itself unseen till then), so opening one goes from the skeleton straight to the Artifact, with
 * no empty or white page between. `stage` lays out the box both stand in, which takes the frame's
 * place in its parent; mount it with the frame's key.
 */
export function StagedFrame({
  stage = '',
  onReady,
  ...frame
}: ComponentProps<typeof ArtifactFrame> & { stage?: string }) {
  const [drawn, setDrawn] = useState(false);

  return (
    <div className={`relative flex min-h-0 min-w-0 flex-1 flex-col ${stage}`}>
      <ArtifactFrame
        {...frame}
        onReady={() => {
          setDrawn(true);
          onReady?.();
        }}
      />
      {!drawn && <ArtifactSkeleton className="pointer-events-none absolute inset-0" />}
    </div>
  );
}
