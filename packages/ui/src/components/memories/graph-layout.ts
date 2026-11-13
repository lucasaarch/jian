import type { Memory } from '../../lib/api';

/** The drawing's own units; the view scales them to the screen. */
export const GRAPH_WIDTH = 1000;
export const GRAPH_HEIGHT = 640;
const MARGIN = 60;
const STEPS = 220;
/** How hard a link pulls its two memories together, against the push between every pair. */
const ATTRACT = 0.35;
/** The pull of the middle, which keeps memories with no link from drifting to the edge. */
const GRAVITY = 0.06;
/** Past this many link lengths two memories ignore each other. */
const REACH = 2.2;

type GraphNode = { key: string; x: number; y: number; degree: number };
export type GraphEdge = { from: string; to: string };
export type Graph = { nodes: GraphNode[]; edges: GraphEdge[] };

/** Each link once, whichever memory names it, and only between memories that exist. */
export function graphEdges(memories: Memory[]): GraphEdge[] {
  const keys = new Set(memories.map((memory) => memory.key));
  const seen = new Set<string>();
  const edges: GraphEdge[] = [];

  for (const memory of memories) {
    for (const other of memory.links ?? []) {
      const [from, to] = memory.key < other ? [memory.key, other] : [other, memory.key];
      const id = `${from}\n${to}`;

      if (from === to || seen.has(id) || !keys.has(from) || !keys.has(to)) continue;
      seen.add(id);
      edges.push({ from, to });
    }
  }

  return edges.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
}

/**
 * Where each memory sits: a force layout run to the end once, from a fixed start (keys in
 * order along a spiral), so the same memories always make the same map and nothing moves
 * while the owner reads it. Links pull, every pair pushes, and a weak pull to the middle
 * keeps unlinked ones from drifting off.
 */
export function layoutGraph(memories: Memory[]): Graph {
  const keys = memories.map((memory) => memory.key).sort();
  const edges = graphEdges(memories);
  const count = keys.length;
  const index = new Map(keys.map((key, at) => [key, at]));
  const degree = keys.map(() => 0);
  const links = edges.map(({ from, to }) => [index.get(from) ?? 0, index.get(to) ?? 0] as const);

  for (const [a, b] of links) {
    degree[a] = (degree[a] ?? 0) + 1;
    degree[b] = (degree[b] ?? 0) + 1;
  }

  const cx = GRAPH_WIDTH / 2;
  const cy = GRAPH_HEIGHT / 2;
  const spread = Math.sqrt((GRAPH_WIDTH * GRAPH_HEIGHT) / Math.max(count, 1)) * 0.75;
  const x = keys.map((_, at) => cx + Math.cos(at * 2.399963) * Math.sqrt(at + 0.5) * spread * 0.45);
  const y = keys.map((_, at) => cy + Math.sin(at * 2.399963) * Math.sqrt(at + 0.5) * spread * 0.45);

  for (let step = 0; step < STEPS; step += 1) {
    const heat = 1 - step / STEPS;
    const dx = keys.map(() => 0);
    const dy = keys.map(() => 0);

    for (let a = 0; a < count; a += 1) {
      for (let b = a + 1; b < count; b += 1) {
        const gx = (x[a] ?? 0) - (x[b] ?? 0);
        const gy = (y[a] ?? 0) - (y[b] ?? 0);
        const distance = Math.max(Math.hypot(gx, gy), 1);
        // Short-ranged: a far memory does not push, so loners are not flung out of the map.
        const push = distance > spread * REACH ? 0 : (spread * spread) / distance / distance;

        dx[a] = (dx[a] ?? 0) + gx * push;
        dy[a] = (dy[a] ?? 0) + gy * push;
        dx[b] = (dx[b] ?? 0) - gx * push;
        dy[b] = (dy[b] ?? 0) - gy * push;
      }
    }

    for (const [a, b] of links) {
      const gx = (x[a] ?? 0) - (x[b] ?? 0);
      const gy = (y[a] ?? 0) - (y[b] ?? 0);
      const distance = Math.max(Math.hypot(gx, gy), 1);
      const pull = (distance / spread) * ATTRACT;

      dx[a] = (dx[a] ?? 0) - gx * pull;
      dy[a] = (dy[a] ?? 0) - gy * pull;
      dx[b] = (dx[b] ?? 0) + gx * pull;
      dy[b] = (dy[b] ?? 0) + gy * pull;
    }

    for (let at = 0; at < count; at += 1) {
      const px = (x[at] ?? 0) + (dx[at] ?? 0) * 0.5 + (cx - (x[at] ?? 0)) * GRAVITY;
      const py = (y[at] ?? 0) + (dy[at] ?? 0) * 0.5 + (cy - (y[at] ?? 0)) * GRAVITY;
      const limit = spread * 0.6 * heat + 2;
      const move = Math.hypot(px - (x[at] ?? 0), py - (y[at] ?? 0));
      const scale = move > limit ? limit / move : 1;

      x[at] = (x[at] ?? 0) + (px - (x[at] ?? 0)) * scale;
      y[at] = (y[at] ?? 0) + (py - (y[at] ?? 0)) * scale;
    }
  }

  // Fitted to the drawing, so a tight cluster fills it and a sprawl is not cut off.
  const minX = Math.min(...x);
  const maxX = Math.max(...x);
  const minY = Math.min(...y);
  const maxY = Math.max(...y);
  const fit = Math.min(
    (GRAPH_WIDTH - 2 * MARGIN) / Math.max(maxX - minX, 1),
    (GRAPH_HEIGHT - 2 * MARGIN) / Math.max(maxY - minY, 1),
    count > 1 ? 2.5 : 1,
  );

  return {
    edges,
    nodes: keys.map((key, at) => ({
      key,
      degree: degree[at] ?? 0,
      x: cx + ((x[at] ?? 0) - (minX + maxX) / 2) * fit,
      y: cy + ((y[at] ?? 0) - (minY + maxY) / 2) * fit,
    })),
  };
}

/** The memories one step from this one on the map. */
export function neighbours(edges: GraphEdge[], key: string): Set<string> {
  const found = new Set<string>();

  for (const { from, to } of edges) {
    if (from === key) found.add(to);
    if (to === key) found.add(from);
  }

  return found;
}
