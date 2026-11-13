'use client';

import { Maximize2, ZoomIn, ZoomOut } from 'lucide-react';
import { type KeyboardEvent, type MouseEvent, useMemo } from 'react';
import { type Graph, neighbours } from '../../components/memories/graph-layout';
import { usePanZoom } from '../../components/memories/use-pan-zoom';
import { iconButton, surfaceCard } from '../../kit';

/** Characters of a key shown under its node; the full key is its accessible name. */
const LABEL_CHARS = 20;

const short = (key: string) =>
  key.length > LABEL_CHARS ? `${key.slice(0, LABEL_CHARS - 1)}…` : key;

type Props = {
  graph: Graph;
  selected: string;
  /** Memories that match the search and project; null when nothing narrows the map. */
  lit: Set<string> | null;
  /** Memories pinned to the project being looked at, drawn in the project colour. */
  tinted: Set<string>;
  /** `link` is a shift-click: the owner asks to link or unlink the pair, not to open one. */
  onSelect: (key: string, link: boolean) => void;
};

/**
 * The memories as a map: a node each, a line for every link. Laid out once by
 * `layoutGraph`, so it holds still while it is read. Every node can be reached with Tab and
 * opened with Enter; the list view is the plain alternative to all of it.
 */
export function MemoryMap({ graph, selected, lit, tinted, onSelect }: Props) {
  const pan = usePanZoom();
  const near = useMemo(() => neighbours(graph.edges, selected), [graph.edges, selected]);
  const at = useMemo(() => new Map(graph.nodes.map((node) => [node.key, node])), [graph.nodes]);

  return (
    <div
      className={`relative min-h-[34rem] min-w-0 overflow-hidden ${surfaceCard} phone:min-h-[26rem]`}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: an <svg> cannot be a <fieldset> */}
      <svg
        ref={pan.svg}
        viewBox={pan.viewBox}
        role="group"
        aria-label="Memory map"
        className="absolute inset-0 size-full cursor-grab touch-none select-none active:cursor-grabbing"
        {...pan.handlers}
      >
        <g className="stroke-muted/50">
          {graph.edges.map(({ from, to }) => {
            const a = at.get(from);
            const b = at.get(to);
            const touches = selected === from || selected === to;
            const faded = lit ? !(lit.has(from) && lit.has(to)) && !touches : false;

            return a && b ? (
              <line
                key={`${from}|${to}`}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                strokeWidth={touches ? 2.2 : 1.2}
                className={`${touches ? 'stroke-accent' : ''} ${faded ? 'opacity-20' : ''}`}
              />
            ) : null;
          })}
        </g>
        {graph.nodes.map((node) => {
          const chosen = node.key === selected;
          const adjacent = near.has(node.key);
          const dimmed = !chosen && !adjacent && (lit ? !lit.has(node.key) : selected !== '');
          const radius = 9 + Math.min(node.degree, 6) * 1.8;

          return (
            <MapNode
              key={node.key}
              name={node.key}
              x={node.x}
              y={node.y}
              radius={radius}
              state={
                chosen ? 'selected' : adjacent ? 'near' : tinted.has(node.key) ? 'project' : 'idle'
              }
              dimmed={dimmed}
              dragged={pan.dragged}
              onSelect={onSelect}
            />
          );
        })}
      </svg>
      <div className="absolute right-3 bottom-3 flex items-center gap-0.5 rounded-full border border-glass-edge bg-canvas/70 p-0.5 backdrop-blur-md">
        <button type="button" aria-label="Zoom in" className={iconButton} onClick={pan.zoomIn}>
          <ZoomIn size={15} aria-hidden="true" />
        </button>
        <button type="button" aria-label="Zoom out" className={iconButton} onClick={pan.zoomOut}>
          <ZoomOut size={15} aria-hidden="true" />
        </button>
        <button type="button" aria-label="Fit the map" className={iconButton} onClick={pan.reset}>
          <Maximize2 size={14} aria-hidden="true" />
        </button>
      </div>
      <p className="pointer-events-none absolute bottom-3 left-4 text-xs text-muted phone:hidden">
        Scroll to zoom · drag to pan · Shift-click a memory to link it to the open one
      </p>
    </div>
  );
}

const fills = {
  idle: 'fill-glass-press stroke-muted',
  near: 'fill-accent-soft stroke-accent',
  project: 'fill-good-soft stroke-good',
  selected: 'fill-accent stroke-accent',
} as const;

function MapNode({
  name,
  x,
  y,
  radius,
  state,
  dimmed,
  dragged,
  onSelect,
}: {
  name: string;
  x: number;
  y: number;
  radius: number;
  state: keyof typeof fills;
  dimmed: boolean;
  dragged: { current: boolean };
  onSelect: (key: string, link: boolean) => void;
}) {
  const open = (event: MouseEvent | KeyboardEvent) => onSelect(name, event.shiftKey);

  return (
    // biome-ignore lint/a11y/useSemanticElements: an SVG group cannot be a <button>
    <g
      role="button"
      tabIndex={0}
      aria-label={name}
      aria-pressed={state === 'selected'}
      className={`group cursor-pointer outline-none transition-opacity ${dimmed ? 'opacity-30' : ''}`}
      onClick={(event) => {
        if (!dragged.current) open(event);
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        open(event);
      }}
    >
      <circle
        cx={x}
        cy={y}
        r={radius + 5}
        strokeWidth={2}
        className="fill-transparent stroke-transparent group-focus-visible:stroke-ink/60"
      />
      {/* An opaque base, so the lines passing under a node do not show through its tint. */}
      <circle cx={x} cy={y} r={radius} className="fill-canvas" />
      <circle cx={x} cy={y} r={radius} strokeWidth={1.8} className={fills[state]} />
      <text
        x={x}
        y={y + radius + 17}
        textAnchor="middle"
        className={`pointer-events-none [paint-order:stroke] stroke-canvas stroke-[4px] text-[13px] ${state === 'selected' ? 'fill-ink font-medium' : 'fill-muted'}`}
      >
        {short(name)}
      </text>
    </g>
  );
}
