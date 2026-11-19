'use client';

import { Shapes } from 'lucide-react';
import type { ReactNode } from 'react';
import { surfaceCard } from '../../../../kit';
import type { ArtifactDraft } from '../../../../lib/stores/artifact-draft';
import { InspectorBody } from '../../inspector';
import { KIND_TINT, KindIcon } from '../kind';
import { TYPE_NAME } from '../source';
import { buildingWords, written } from './progress';
import { BuildingShape } from './shapes';

/**
 * What it is and how far along, over what is being made: the type's icon, the title as it
 * arrives, and words that move on from Generating… to Building… to Almost there… as more is
 * written. Shared by the picture of one being made and a deck's slides coming in.
 */
export function BuildingHead({ draft, progress }: { draft: ArtifactDraft; progress: number }) {
  const type = draft.type;
  return (
    <header className="flex min-w-0 items-center gap-3">
      <span
        className={`grid size-9 shrink-0 place-items-center rounded-xl ${type ? KIND_TINT[type] : 'bg-glass-press text-ink'}`}
      >
        {type ? (
          <KindIcon artifact={{ type }} size={17} className="" />
        ) : (
          <Shapes size={17} aria-hidden="true" />
        )}
      </span>
      <span className="grid min-w-0 gap-0.5">
        <span className="truncate text-[13px] font-medium text-ink">
          {draft.title || 'New artifact'}
        </span>
        <span className="flex gap-1.5 text-xs text-muted">
          {type && <span>{TYPE_NAME[type]}</span>}
          {type && <span aria-hidden="true">·</span>}
          <span role="status">{buildingWords(progress)}</span>
        </span>
      </span>
    </header>
  );
}

/** The column what is being made stands in, a card's width at most, a little down from the bar. */
export function BuildingColumn({ children }: { children: ReactNode }) {
  return (
    <InspectorBody className="px-(--inspector-inset)">
      <div className="mx-auto grid w-full max-w-lg grid-cols-1 gap-4 pt-6">{children}</div>
    </InspectorBody>
  );
}

/**
 * An Artifact the agent is making, before there is anything of it to draw: never its source, but
 * a card holding the shape of what it will be, filling in calmly as the source grows
 * (shapes.tsx). Its light sweeps stop for reduced motion; the words still move on.
 */
export function Building({ draft }: { draft: ArtifactDraft }) {
  const progress = written(draft.type, draft.content.length, Boolean(draft.done));
  return (
    <BuildingColumn>
      <div className={`grid gap-5 p-4 ${surfaceCard}`}>
        <BuildingHead draft={draft} progress={progress} />
        <BuildingShape type={draft.type} progress={progress} />
      </div>
    </BuildingColumn>
  );
}
