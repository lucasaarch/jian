'use client';

import type { ArtifactsApi } from '../../components/sessions/artifacts/use-artifacts';
import { Skeleton, SkeletonLine, surfaceCard } from '../../kit';
import type { ArtifactFolder, ProfileArtifact } from '../../lib/api';
import { ArtifactCard, type CardActions } from './artifact-card';

/**
 * As many columns as fit cards no narrower than a minimum, counted from the room the grid itself
 * is given, never from the window's: it stays right beside an open sidebar and on a phone alike.
 * A lone card keeps a card's width. The page's cards are at least 14rem; the Inspector's, in a
 * column that is often under 30rem, at least 11rem, so two still sit side by side there.
 */
export const CARD_COLUMNS = {
  page: 'grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-4 phone:gap-3',
  inspector: 'grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-3',
} as const;

/** Some of the agent's Artifacts as the page's cards, in the order given. */
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
    <ul aria-label={label} className={`min-w-0 ${CARD_COLUMNS.page}`}>
      {artifacts.map((artifact) => (
        <ArtifactCard
          key={artifact.id}
          api={api}
          profileId={profileId}
          artifact={artifact}
          onOpen={() => on.open(artifact)}
          tools={{
            rename: () => on.rename(artifact),
            duplicate: () => on.duplicate(artifact),
            delete: () => on.delete(artifact),
            keeping: {
              pinned: artifact.pinned,
              pin: () => on.pin(artifact),
              go: () => on.go(artifact),
              folderId: artifact.folderId,
              folders,
              home: home(artifact),
              move: (folderId) => on.move(artifact, folderId),
              moveToNew: () => on.moveToNew(artifact),
            },
          }}
        />
      ))}
    </ul>
  );
}

/** The grid's shape while it is read: cards of the same size, so nothing moves when it lands. */
export function ArtifactsGridSkeleton({
  count = 6,
  columns = CARD_COLUMNS.page,
}: {
  count?: number;
  columns?: string;
}) {
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
