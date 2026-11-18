'use client';

import type { ArtifactsApi } from '../../components/sessions/artifacts/use-artifacts';
import { Skeleton, SkeletonLine, surfaceCard } from '../../kit';
import type { ArtifactFolder, ProfileArtifact } from '../../lib/api';
import { ArtifactCard, type CardActions } from './artifact-card';

/**
 * As many columns as fit cards no narrower than 14rem, counted from the room the grid itself is
 * given, never from the window's: it stays right beside an open sidebar and on a phone alike. A
 * lone card keeps a card's width.
 */
const columns = 'grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-4 phone:gap-3';

/** Some of the agent's Artifacts as cards, in the order given. */
export function ArtifactsGrid({
  label,
  api,
  profileId,
  artifacts,
  folders,
  home,
  on,
}: {
  /** What these are, for assistive technology: the pinned ones, or the rest. */
  label: string;
  api: ArtifactsApi;
  profileId: string;
  artifacts: ProfileArtifact[];
  folders: ArtifactFolder[];
  /** The name of where one started, which it can be moved back to. */
  home: (artifact: ProfileArtifact) => string;
  on: CardActions;
}) {
  return (
    <ul aria-label={label} className={`min-w-0 ${columns}`}>
      {artifacts.map((artifact) => (
        <ArtifactCard
          key={artifact.id}
          api={api}
          profileId={profileId}
          artifact={artifact}
          folders={folders}
          home={home(artifact)}
          on={on}
        />
      ))}
    </ul>
  );
}

/** The grid's shape while it is read: cards of the same size, so nothing moves when it lands. */
export function ArtifactsGridSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className={columns}>
      {Array.from({ length: count }, (_, card) => card).map((card) => (
        <div key={card} className={`grid grid-cols-1 overflow-hidden ${surfaceCard}`}>
          <Skeleton className="aspect-video rounded-none" />
          <div className="grid gap-2 px-3 py-3">
            <SkeletonLine className="w-2/3" />
            <SkeletonLine className="w-1/3" />
          </div>
        </div>
      ))}
    </div>
  );
}
