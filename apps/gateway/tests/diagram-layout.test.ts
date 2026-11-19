import { describe, expect, it } from 'vitest';
import { DIAGRAM_LAYOUT } from '../src/artifacts/diagram-layout.js';

type Node = {
  id: string;
  label: string;
  shape?: string;
  x?: number;
  y?: number;
  group?: string;
};
type Diagram = {
  direction?: 'TB' | 'LR';
  nodes: Node[];
  edges?: { from: string; to: string }[];
};

/** The script the frame runs, run here as the very same text. */
const { layout, sizeOf } = new Function(`${DIAGRAM_LAYOUT}\nreturn { layout, sizeOf };`)() as {
  layout: (diagram: Diagram) => void;
  sizeOf: (node: Node) => [number, number];
};

const boxOf = (node: Node) => {
  const [width, height] = sizeOf(node);
  return {
    left: (node.x as number) - width / 2,
    right: (node.x as number) + width / 2,
    top: (node.y as number) - height / 2,
    bottom: (node.y as number) + height / 2,
  };
};

const overlapping = (nodes: Node[]) => {
  const found: string[] = [];
  nodes.forEach((a, i) => {
    for (const b of nodes.slice(i + 1)) {
      const p = boxOf(a);
      const q = boxOf(b);
      if (p.left < q.right && q.left < p.right && p.top < q.bottom && q.top < p.bottom) {
        found.push(`${a.id}/${b.id}`);
      }
    }
  });
  return found;
};

const laid = (diagram: Diagram) => {
  layout(diagram);
  return Object.fromEntries(diagram.nodes.map((node) => [node.id, node]));
};

describe('the layout of a diagram', () => {
  it('places every node of a flow, each below the one it follows, with none on another', () => {
    const diagram: Diagram = {
      nodes: ['start', 'check', 'yes', 'no', 'merge', 'end'].map((id) => ({ id, label: id })),
      edges: [
        { from: 'start', to: 'check' },
        { from: 'check', to: 'yes' },
        { from: 'check', to: 'no' },
        { from: 'yes', to: 'merge' },
        { from: 'no', to: 'merge' },
        { from: 'merge', to: 'end' },
        // A step back up, which a layered layout must not loop on.
        { from: 'end', to: 'start' },
      ],
    };
    const at = laid(diagram);

    for (const node of diagram.nodes) {
      expect(Number.isFinite(node.x), node.id).toBe(true);
      expect(Number.isFinite(node.y), node.id).toBe(true);
    }
    expect(overlapping(diagram.nodes)).toEqual([]);
    expect(at.check?.y).toBeGreaterThan(at.start?.y as number);
    expect(at.yes?.y).toBe(at.no?.y);
    expect(at.merge?.y).toBeGreaterThan(at.yes?.y as number);
    // The branches stand either side of what they leave.
    const middle = ((at.yes?.x as number) + (at.no?.x as number)) / 2;
    expect(Math.abs(middle - (at.check?.x as number))).toBeLessThan(2);
  });

  it('runs left to right when asked, and lays out nodes with no edge at all', () => {
    const diagram: Diagram = {
      direction: 'LR',
      nodes: [
        { id: 'a', label: 'Ingest' },
        { id: 'b', label: 'Transform the data' },
        { id: 'c', label: 'Store', shape: 'diamond' },
        { id: 'alone', label: 'Not connected to anything' },
      ],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
      ],
    };
    const at = laid(diagram);

    expect(at.b?.x).toBeGreaterThan(at.a?.x as number);
    expect(at.c?.x).toBeGreaterThan(at.b?.x as number);
    expect(overlapping(diagram.nodes)).toEqual([]);
  });

  it('keeps what was placed by hand and puts the rest beside it, never on it', () => {
    const diagram: Diagram = {
      nodes: [
        { id: 'kept', label: 'Placed', x: 100, y: 100 },
        { id: 'other', label: 'Also placed', x: 400, y: 100 },
        { id: 'new', label: 'Added later' },
        { id: 'newer', label: 'And another' },
      ],
      edges: [
        { from: 'kept', to: 'new' },
        { from: 'new', to: 'newer' },
      ],
    };
    const at = laid(diagram);

    expect([at.kept?.x, at.kept?.y, at.other?.x, at.other?.y]).toEqual([100, 100, 400, 100]);
    expect(overlapping(diagram.nodes)).toEqual([]);
    expect(at.newer?.y).toBeGreaterThan(at.new?.y as number);
  });

  it('lays out a few hundred nodes without two of them meeting', () => {
    const nodes: Node[] = [];
    const edges: { from: string; to: string }[] = [];
    for (let i = 0; i < 300; i++) {
      nodes.push({ id: `n${i}`, label: `Step ${i}`, group: i % 7 === 0 ? 'g' : undefined });
      if (i) edges.push({ from: `n${Math.floor((i - 1) / 3)}`, to: `n${i}` });
      if (i > 10 && i % 5 === 0) edges.push({ from: `n${i - 9}`, to: `n${i}` });
    }
    const diagram: Diagram = { nodes, edges };
    layout(diagram);

    expect(nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(true);
    expect(overlapping(nodes)).toEqual([]);
  });
});
