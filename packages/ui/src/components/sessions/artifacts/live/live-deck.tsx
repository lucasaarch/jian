'use client';

import { surfaceCard } from '../../../../kit';
import type { ArtifactDraft } from '../../../../lib/stores/artifact-draft';
import { SlideFrame } from '../deck/slide-frame';
import { BuildingColumn, BuildingHead } from './building';
import { written } from './progress';
import { SlideShape } from './shapes';

/**
 * A deck the agent is writing, slide by slide: each one finished drawn small, in the same sealed
 * frame as any slide, as it is finished, and the one being written as the shape of a slide filling
 * in. A slide is drawn only once it is whole (the gateway's draft says which are), so no half
 * page ever runs. Like a card's picture, a slide here is looked at, not used.
 */
export function LiveDeck({ draft }: { draft: ArtifactDraft & { slides: string[] } }) {
  const progress = written('deck', draft.content.length, Boolean(draft.done));
  const title = draft.title || 'New deck';
  return (
    <BuildingColumn>
      <BuildingHead draft={draft} progress={progress} />
      <ol aria-label="Slides" className="grid grid-cols-2 gap-3">
        {draft.slides.map((slide, index) => (
          // A finished slide never changes while the deck is written: its place is its name.
          // biome-ignore lint/suspicious/noArrayIndexKey: slides only ever come after the last.
          <li key={index} className="building-arrive grid gap-1.5">
            <div
              inert
              className={`aspect-video overflow-hidden [filter:opacity(1)] ${surfaceCard}`}
            >
              <SlideFrame
                title={`${title}, slide ${index + 1}`}
                source={slide}
                className="size-full"
              />
            </div>
            <span className="text-xs text-muted tabular-nums">{index + 1}</span>
          </li>
        ))}
        {!draft.done && (
          <li
            className="grid gap-1.5"
            aria-label={`Slide ${draft.slides.length + 1}, being written`}
          >
            <SlideShape />
            <span className="text-xs text-muted tabular-nums">{draft.slides.length + 1}</span>
          </li>
        )}
      </ol>
    </BuildingColumn>
  );
}
