/**
 * Where a diagram's nodes go when it does not say, as script kept as text: it defines
 * `sizeOf(node)`, the `[width, height]` a node is drawn at, and `layout(diagram)`, which gives
 * every node lacking `x` and `y` a centre and leaves the others where they are.
 *
 * Written here rather than bundled: the layered layouts that ship as one file (dagre, elk) are
 * hundreds of kilobytes for what a few hundred lines do, and this one runs in the frame and,
 * as the very same text, in the gateway's tests. It is the classic layered drawing (Sugiyama):
 *
 * 1. Cycles are broken by turning round each edge that leads back up a depth-first walk.
 * 2. Each node takes the layer one past its deepest predecessor; a source sits just above the
 *    first node it leads to, not at the top of a long diagram.
 * 3. An edge that spans several layers passes through placeholders, one a layer, so the order
 *    of each layer can make room for it.
 * 4. Layers are ordered by the mean place of their neighbours, sweeping down and up, keeping the
 *    order that crosses fewest edges. Members of one group are kept side by side.
 * 5. Each node moves towards its neighbours, and a pass from each side keeps the gaps; the
 *    result is the mean of both passes, so nothing drifts to one side. Then what stands inside
 *    a group's frame without belonging to it is pushed out to the side it was nearer.
 *
 * Sizes come from the label's length, not from measuring it, so the gateway and the frame agree
 * and nothing waits for a font. Nodes placed by hand are untouched; the ones laid out go beside
 * them, to the right (top to bottom) or below (left to right), so they never land on them.
 *
 * No template literal inside: this file is one already.
 */
export const DIAGRAM_LAYOUT = String.raw`
const sizeOf = (node) => {
  // About what a character takes at the frame's 14px, generous so a label rarely spills.
  const shape = node.shape || 'rounded';
  const text = shape === 'text';
  // A text is set larger and bolder than a box's label.
  const CHAR = text ? 9 : 7.6;
  const lines = String(node.label || '').split('\n');
  const longest = Math.max(1, ...lines.map((line) => line.length));
  const pad = text ? 8 : 32;
  let width = Math.min(text ? 360 : 240, Math.max(text ? 40 : 120, Math.round(longest * CHAR) + pad));
  const fits = Math.max(1, Math.floor((width - pad) / CHAR));
  const count = lines.reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / fits)), 0);
  let height = Math.max(text ? 28 : 48, count * 20 + (text ? 8 : 24));
  // A diamond and an ellipse hold their words in less of their box than a rectangle does.
  if (shape === 'diamond') {
    width = Math.round(width * 1.5);
    height = Math.round(height * 1.6);
  } else if (shape === 'ellipse') {
    width = Math.round(width * 1.2);
    height = Math.round(height * 1.3);
  } else if (shape === 'note') {
    width = Math.max(width, 150);
    height = Math.max(height, 100);
  }
  return [node.width || width, node.height || height];
};

const layout = (diagram) => {
  const loose = diagram.nodes.filter((node) => typeof node.x !== 'number' || typeof node.y !== 'number');
  if (!loose.length) return;
  const across = diagram.direction === 'LR' ? 1 : 0;
  const count = loose.length;
  const index = new Map(loose.map((node, i) => [node.id, i]));
  const extent = loose.map(sizeOf);

  // The edges among the nodes laid out, once each and none to itself.
  const out = loose.map(() => []);
  const seen = new Set();
  for (const edge of diagram.edges || []) {
    const a = index.get(edge.from);
    const b = index.get(edge.to);
    if (a === undefined || b === undefined || a === b || seen.has(a + ',' + b)) continue;
    seen.add(a + ',' + b);
    out[a].push(b);
  }

  // 1. A walk from the sources first, so the diagram reads from where it starts.
  const into = new Array(count).fill(0);
  for (const list of out) for (const b of list) into[b]++;
  const forward = loose.map(() => []);
  const state = new Array(count).fill(0);
  const walk = (start) => {
    const stack = [[start, 0]];
    state[start] = 1;
    while (stack.length) {
      const top = stack[stack.length - 1];
      const a = top[0];
      if (top[1] >= out[a].length) {
        state[a] = 2;
        stack.pop();
        continue;
      }
      const b = out[a][top[1]++];
      if (state[b] === 1) forward[b].push(a);
      else {
        forward[a].push(b);
        if (state[b] === 0) {
          state[b] = 1;
          stack.push([b, 0]);
        }
      }
    }
  };
  for (let i = 0; i < count; i++) if (!into[i] && !state[i]) walk(i);
  for (let i = 0; i < count; i++) if (!state[i]) walk(i);

  // 2. Layers, in an order where every edge points down.
  const preds = loose.map(() => []);
  for (let a = 0; a < count; a++) for (const b of forward[a]) preds[b].push(a);
  const waiting = preds.map((list) => list.length);
  const order = [];
  for (let i = 0; i < count; i++) if (!waiting[i]) order.push(i);
  for (let at = 0; at < order.length; at++) {
    for (const b of forward[order[at]]) if (--waiting[b] === 0) order.push(b);
  }
  const layer = new Array(count).fill(0);
  for (const a of order) for (const b of forward[a]) layer[b] = Math.max(layer[b], layer[a] + 1);
  for (let at = order.length - 1; at >= 0; at--) {
    const a = order[at];
    if (preds[a].length || !forward[a].length) continue;
    layer[a] = Math.min(...forward[a].map((b) => layer[b])) - 1;
  }

  // 3. Placeholders: item i < count is a node, any later one a point of a long edge.
  const items = loose.map((node, i) => ({ layer: layer[i], up: [], down: [], group: node.group, size: extent[i] }));
  for (let a = 0; a < count; a++) {
    for (const b of forward[a]) {
      let from = a;
      for (let l = layer[a] + 1; l < layer[b]; l++) {
        items.push({ layer: l, up: [from], down: [], size: [0, 0] });
        items[from].down.push(items.length - 1);
        from = items.length - 1;
      }
      items[from].down.push(b);
      items[b].up.push(from);
    }
  }
  const depth = Math.max(...items.map((item) => item.layer)) + 1;
  const layers = Array.from({ length: depth }, () => []);
  // First come, first placed: the walk's order is a fair start for the sweeps.
  const placed = new Set();
  const enter = (i) => {
    if (placed.has(i)) return;
    placed.add(i);
    layers[items[i].layer].push(i);
  };
  for (const a of order) {
    enter(a);
    for (const b of items[a].down) enter(b);
  }
  for (let i = 0; i < items.length; i++) enter(i);

  // 4. Order within each layer.
  const where = new Array(items.length).fill(0);
  const number = () => {
    for (const row of layers) row.forEach((i, at) => (where[i] = at));
  };
  const crossings = () => {
    let total = 0;
    for (let l = 0; l + 1 < depth; l++) {
      const pairs = [];
      for (const a of layers[l]) for (const b of items[a].down) pairs.push([where[a], where[b]]);
      for (let p = 0; p < pairs.length; p++) {
        for (let q = p + 1; q < pairs.length; q++) {
          const dx = pairs[p][0] - pairs[q][0];
          const dy = pairs[p][1] - pairs[q][1];
          if (dx * dy < 0) total++;
        }
      }
    }
    return total;
  };
  // Members of a group side by side, where the group's members stand on average.
  const gather = (row) => {
    const sums = new Map();
    for (const i of row) {
      const group = items[i].group;
      if (group === undefined) continue;
      const sum = sums.get(group) || [0, 0];
      sums.set(group, [sum[0] + where[i], sum[1] + 1]);
    }
    if (!sums.size) return;
    const key = (i) => {
      const sum = sums.get(items[i].group);
      return sum ? sum[0] / sum[1] : where[i];
    };
    row.sort((a, b) => key(a) - key(b) || String(items[a].group).localeCompare(String(items[b].group)) || where[a] - where[b]);
  };
  const sweep = (row, side) => {
    const mean = new Map();
    for (const i of row) {
      const near = items[i][side];
      mean.set(i, near.length ? near.reduce((sum, j) => sum + where[j], 0) / near.length : where[i]);
    }
    row.sort((a, b) => mean.get(a) - mean.get(b) || where[a] - where[b]);
    row.forEach((i, at) => (where[i] = at));
    gather(row);
    row.forEach((i, at) => (where[i] = at));
  };
  number();
  let best = layers.map((row) => row.slice());
  let fewest = crossings();
  for (let round = 0; round < 12 && fewest > 0; round++) {
    for (let l = 1; l < depth; l++) sweep(layers[l], 'up');
    for (let l = depth - 2; l >= 0; l--) sweep(layers[l], 'down');
    const now = crossings();
    if (now < fewest) {
      fewest = now;
      best = layers.map((row) => row.slice());
    }
  }
  best.forEach((row, l) => (layers[l] = row));
  number();

  // 5. Places: along the layers, then across them.
  const grouped = [...new Set(loose.map((node) => node.group).filter((group) => group !== undefined))];
  const GAP_ACROSS = 40;
  // Between two layers, room for the frames of different groups: a margin under one and a
  // margin and a title over the next.
  const GAP_ALONG = (across ? 90 : 72) + (grouped.length ? 28 : 0);
  const along = [];
  let at = 0;
  for (const row of layers) {
    const thick = Math.max(0, ...row.map((i) => items[i].size[1 - across]));
    along.push(at + thick / 2);
    at += thick + GAP_ALONG;
  }
  const wide = (i) => items[i].size[across];
  const gap = (a, b) => {
    const dummies = (a >= count) + (b >= count);
    const base = dummies === 2 ? 14 : dummies === 1 ? 24 : GAP_ACROSS;
    // Room for a group's frame between members of different groups.
    return (wide(a) + wide(b)) / 2 + base + (items[a].group !== items[b].group ? 28 : 0);
  };
  const place = new Array(items.length).fill(0);
  for (const row of layers) {
    let x = 0;
    row.forEach((i, k) => {
      if (k) x += gap(row[k - 1], i);
      place[i] = x;
    });
    for (const i of row) place[i] -= x / 2;
  }
  const settle = (row, side) => {
    if (!row.length) return;
    const wanted = row.map((i) => {
      const near = items[i][side];
      return near.length ? near.reduce((sum, j) => sum + place[j], 0) / near.length : place[i];
    });
    const left = wanted.slice();
    for (let k = 1; k < row.length; k++) left[k] = Math.max(left[k], left[k - 1] + gap(row[k - 1], row[k]));
    const right = wanted.slice();
    for (let k = row.length - 2; k >= 0; k--) right[k] = Math.min(right[k], right[k + 1] - gap(row[k], row[k + 1]));
    row.forEach((i, k) => (place[i] = (left[k] + right[k]) / 2));
  };
  for (let round = 0; round < 8; round++) {
    for (let l = 1; l < depth; l++) settle(layers[l], 'up');
    for (let l = depth - 2; l >= 0; l--) settle(layers[l], 'down');
  }
  // A group's frame spans every layer its members are in, so a node outside it that stands
  // within its width in one of those layers is pushed clear, with the rest of its row.
  for (let round = 0; round < 4 && grouped.length; round++) {
    let pushed = false;
    for (const group of grouped) {
      let low = Infinity;
      let high = -Infinity;
      let first = Infinity;
      let last = -Infinity;
      for (let i = 0; i < count; i++) {
        if (items[i].group !== group) continue;
        low = Math.min(low, place[i] - wide(i) / 2);
        high = Math.max(high, place[i] + wide(i) / 2);
        first = Math.min(first, items[i].layer);
        last = Math.max(last, items[i].layer);
      }
      for (let l = first; l <= last; l++) {
        const row = layers[l];
        for (let k = 0; k < row.length; k++) {
          const i = row[k];
          if (i >= count || items[i].group === group) continue;
          // Its own frame's margin too, when it is in another group.
          const clear = items[i].group === undefined ? 40 : 64;
          const start = place[i] - wide(i) / 2;
          const end = place[i] + wide(i) / 2;
          if (end <= low - clear || start >= high + clear) continue;
          pushed = true;
          if (place[i] >= (low + high) / 2) {
            const by = high + clear - start;
            for (let j = k; j < row.length; j++) place[row[j]] += by;
          } else {
            const by = end - (low - clear);
            for (let j = k; j >= 0; j--) place[row[j]] -= by;
          }
        }
      }
    }
    if (!pushed) break;
  }

  // Beside what was placed by hand, if anything was.
  const fixed = diagram.nodes.filter((node) => !loose.includes(node));
  // In the axis across the layers the block starts past their far edge; along it, level with
  // their near one.
  let shift = [0, 0];
  if (fixed.length) {
    let far = -Infinity;
    let near = Infinity;
    for (const node of fixed) {
      const [w, h] = sizeOf(node);
      far = Math.max(far, across ? node.y + h / 2 : node.x + w / 2);
      near = Math.min(near, across ? node.x - w / 2 : node.y - h / 2);
    }
    let first = Infinity;
    for (let i = 0; i < count; i++) first = Math.min(first, place[i] - wide(i) / 2);
    shift = [far + 120 - first, near];
  }
  loose.forEach((node, i) => {
    const a = Math.round(place[i] + shift[0]);
    const b = Math.round(along[layer[i]] + shift[1]);
    node.x = across ? b : a;
    node.y = across ? a : b;
  });
};
`;
