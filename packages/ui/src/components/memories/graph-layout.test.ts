import { expect, it } from 'vitest';
import type { Memory } from '../../lib/api';
import { GRAPH_HEIGHT, GRAPH_WIDTH, graphEdges, layoutGraph, neighbours } from './graph-layout';

const memory = (key: string, links: string[] = []) => ({ key, links }) as unknown as Memory;

const topic = [
  memory('atlas', ['maya', 'deploys', 'invoices']),
  memory('maya', ['atlas', 'updates']),
  memory('deploys', ['atlas', 'releases']),
  memory('invoices', ['atlas']),
  memory('updates', ['maya']),
  memory('releases', ['deploys']),
  memory('tea'),
  memory('garden'),
  memory('harbor', ['travel']),
  memory('travel', ['harbor']),
];

it('lays the same memories out the same way, whatever order they arrive in', () => {
  expect(layoutGraph([...topic].reverse())).toEqual(layoutGraph(topic));
});

it('keeps every memory inside the drawing and apart from the others', () => {
  const { nodes } = layoutGraph(topic);

  for (const node of nodes) {
    expect(node.x).toBeGreaterThan(0);
    expect(node.x).toBeLessThan(GRAPH_WIDTH);
    expect(node.y).toBeGreaterThan(0);
    expect(node.y).toBeLessThan(GRAPH_HEIGHT);
  }
  for (const a of nodes) {
    for (const b of nodes.filter((other) => other.key > a.key)) {
      expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(40);
    }
  }
});

it('draws a link once, and none to a memory that is gone', () => {
  const edges = graphEdges([memory('a', ['b', 'gone']), memory('b', ['a'])]);

  expect(edges).toEqual([{ from: 'a', to: 'b' }]);
  expect([...neighbours(edges, 'b')]).toEqual(['a']);
  expect(layoutGraph([]).nodes).toEqual([]);
});
