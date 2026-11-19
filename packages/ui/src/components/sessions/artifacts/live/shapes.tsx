'use client';

import type { SessionArtifactType } from '@jian/contracts';
import { type CSSProperties, createContext, type ReactNode, useContext } from 'react';

/** How many of a shape's blocks are in sight: they come in order as the Artifact is written. */
const Shown = createContext(Number.POSITIVE_INFINITY);

/**
 * One block of what is coming, numbered in the order it comes in. Before its turn it holds its
 * place unseen, so the shape never moves as it fills. The light that passes over each starts a
 * little after the one before, so it reads as one sweep.
 */
function Block({ n, className }: { n: number; className: string }) {
  const shown = useContext(Shown);
  return (
    <span
      aria-hidden="true"
      className={`block ${n > shown ? 'invisible' : 'building-block'} ${className}`}
      style={{ '--sheen-delay': `${(n % 8) * 0.14}s` } as CSSProperties}
    />
  );
}

/** A web page: its bar, a large first block, a row of cards, a few lines. */
function PageShape() {
  return (
    <div className="grid gap-3">
      <div className="flex items-center gap-2">
        <Block n={1} className="size-4 rounded-full" />
        <Block n={1} className="h-2.5 w-16" />
        <span className="flex-1" />
        <Block n={2} className="h-2.5 w-10" />
        <Block n={2} className="h-2.5 w-10" />
        <Block n={2} className="h-2.5 w-10" />
      </div>
      <Block n={3} className="h-24 w-full rounded-xl" />
      <div className="grid grid-cols-3 gap-2">
        <Block n={4} className="h-14 rounded-lg" />
        <Block n={5} className="h-14 rounded-lg" />
        <Block n={6} className="h-14 rounded-lg" />
      </div>
      <Block n={7} className="h-2.5 w-11/12" />
      <Block n={8} className="h-2.5 w-4/5" />
      <Block n={9} className="h-2.5 w-2/3" />
    </div>
  );
}

/** A component, outlined on the dotted canvas it is drawn on. */
function ComponentShape() {
  return (
    <div className="building-canvas grid place-items-center rounded-xl px-4 py-8">
      <div className="grid w-full max-w-64 gap-3 rounded-xl border border-glass-edge bg-canvas/60 p-4">
        <Block n={1} className="h-3 w-1/2" />
        <Block n={2} className="h-2.5 w-5/6" />
        <Block n={3} className="h-8 w-full rounded-lg" />
        <div className="flex justify-end gap-2">
          <Block n={4} className="h-6 w-14 rounded-full" />
          <Block n={5} className="h-6 w-16 rounded-full" />
        </div>
      </div>
    </div>
  );
}

/** A document: a heading, its paragraphs, a heading under it. */
function DocumentShape() {
  return (
    <div className="grid gap-2.5">
      <Block n={1} className="mb-1 h-4 w-1/2" />
      <Block n={2} className="h-2.5 w-full" />
      <Block n={2} className="h-2.5 w-11/12" />
      <Block n={3} className="h-2.5 w-4/5" />
      <Block n={4} className="mt-2 mb-1 h-3 w-1/3" />
      <Block n={5} className="h-2.5 w-full" />
      <Block n={5} className="h-2.5 w-5/6" />
      <Block n={6} className="h-2.5 w-3/4" />
    </div>
  );
}

/** Where each node of a diagram stands, in hundredths of its box, and what joins them. */
const NODES = [
  { n: 1, left: 37.5, top: 4 },
  { n: 2, left: 6, top: 41 },
  { n: 3, left: 69, top: 41 },
  { n: 4, left: 37.5, top: 78 },
];
const LINKS = [
  { n: 2, from: [50, 22], to: [18.5, 41] },
  { n: 3, from: [50, 22], to: [81.5, 41] },
  { n: 4, from: [18.5, 59], to: [50, 78] },
  { n: 4, from: [81.5, 59], to: [50, 78] },
];

/** A diagram: a few nodes and the lines between them. */
function DiagramShape() {
  const shown = useContext(Shown);
  return (
    <div className="relative aspect-[2/1] w-full">
      <svg
        aria-hidden="true"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        className="absolute inset-0 size-full overflow-visible"
      >
        {LINKS.filter((link) => link.n <= shown).map(({ n, from, to }) => (
          <line
            key={`${from}-${to}`}
            x1={from[0]}
            y1={from[1]}
            x2={to[0]}
            y2={to[1]}
            className={`building-link building-link-${n}`}
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      {NODES.map(({ n, left, top }) => (
        <span
          key={n}
          className="absolute h-[18%] w-1/4"
          style={{ left: `${left}%`, top: `${top}%` }}
        >
          <Block n={n} className="size-full rounded-lg" />
        </span>
      ))}
    </div>
  );
}

/** One slide on its canvas: a title and a few lines. */
export function SlideShape() {
  return (
    <div className="grid aspect-video content-center gap-2.5 rounded-lg border border-glass-edge px-[8%]">
      <Block n={1} className="h-4 w-1/2" />
      <Block n={2} className="h-2.5 w-2/3" />
      <Block n={3} className="h-2.5 w-1/2" />
    </div>
  );
}

/** A sheet's cells, five rows of four, by where they stand. */
const CELLS = Array.from({ length: 20 }, (_, cell) => cell);

/** A sheet: its first row, then rows of cells. */
function SheetShape() {
  return (
    <div className="grid grid-cols-4 gap-1">
      {CELLS.map((cell) => (
        <Block
          key={cell}
          n={Math.floor(cell / 4) + 1}
          className={`h-6 rounded-sm ${cell < 4 ? 'opacity-80' : ''}`}
        />
      ))}
    </div>
  );
}

const SHAPES: Record<SessionArtifactType, { shape: () => ReactNode; blocks: number }> = {
  html: { shape: PageShape, blocks: 9 },
  react: { shape: ComponentShape, blocks: 5 },
  markdown: { shape: DocumentShape, blocks: 6 },
  mermaid: { shape: DiagramShape, blocks: 4 },
  deck: { shape: SlideShape, blocks: 3 },
  sheet: { shape: SheetShape, blocks: 5 },
};

/**
 * The shape of what an Artifact of this type will be, filling in as `progress` (0 to 1) goes:
 * the first blocks at once, the last only near the end. Of a type not yet known, a document's.
 */
export function BuildingShape({
  type,
  progress,
}: {
  type: SessionArtifactType | undefined;
  progress: number;
}) {
  const { shape: Shape, blocks } = SHAPES[type ?? 'markdown'];
  return (
    <Shown.Provider value={1 + Math.floor(progress * blocks)}>
      <Shape />
    </Shown.Provider>
  );
}
