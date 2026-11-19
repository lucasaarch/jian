import { DIAGRAM_COLORS, DIAGRAM_SHAPES } from '@jian/contracts';
import { CANVAS_GROUND } from './frame-style.js';

/**
 * A diagram (`diagramContentSchema`) in its frame, as script for the frame's page kept as text:
 * `const diagram = (source, root, editor) => { … }` reads the JSON in `source`, lays out what
 * has no place (diagram-layout.ts) and draws it on the canvas (canvas-frame.ts). With `editor`
 * (diagram-edit.ts) the owner changes it by hand; either way it answers `{ now, changed }`, the
 * JSON as it now stands, which is what the one who collects the edit takes (edit-frame.ts).
 *
 * - Nodes are boxes of the page with their outline in SVG, so a label wraps and is edited as
 *   text; edges are curves in one SVG under them, leaving and reaching each node on the side
 *   that faces the other, with arrowheads from markers. Groups are frames drawn around their
 *   members wherever these are moved.
 * - Colours are names, each with a light and a dark tone (`light-dark`), so a diagram follows
 *   the panel's theme as it changes.
 * - Labels are set as text, never as markup; a colour or a shape outside the lists is drawn as
 *   the default rather than written into the page.
 *
 * What is answered is the source with every node placed, one item a line, so the owner's
 * arrangement is what the agent reads back. Untouched, it is unchanged, even where the layout
 * placed what the agent left unplaced.
 *
 * No template literal inside: this file is one already.
 */

/** Each colour as [light fill, light outline, dark fill, dark outline, light ink, dark ink]. */
const PALETTE: Record<(typeof DIAGRAM_COLORS)[number], readonly string[]> = {
  gray: ['#f4f4f5', '#a1a1aa', '#27272a', '#71717a', '#3f3f46', '#d4d4d8'],
  blue: ['#eff6ff', '#60a5fa', '#172554', '#3b82f6', '#1d4ed8', '#93c5fd'],
  teal: ['#f0fdfa', '#2dd4bf', '#042f2e', '#14b8a6', '#0f766e', '#5eead4'],
  green: ['#f0fdf4', '#4ade80', '#052e16', '#22c55e', '#15803d', '#86efac'],
  yellow: ['#fefce8', '#facc15', '#3a2a06', '#ca8a04', '#a16207', '#fde047'],
  orange: ['#fff7ed', '#fb923c', '#431407', '#f97316', '#c2410c', '#fdba74'],
  red: ['#fef2f2', '#f87171', '#450a0a', '#ef4444', '#b91c1c', '#fca5a5'],
  purple: ['#faf5ff', '#c084fc', '#3b0764', '#a855f7', '#7e22ce', '#d8b4fe'],
  pink: ['#fdf2f8', '#f472b6', '#500724', '#ec4899', '#be185d', '#f9a8d4'],
};

const tones = Object.entries(PALETTE)
  .map(
    ([name, [fill, edge, darkFill, darkEdge, ink, darkInk]]) =>
      `.c-${name} { --fill: light-dark(${fill}, ${darkFill}); --edge: light-dark(${edge}, ${darkEdge}); --tint: light-dark(${ink}, ${darkInk}); }`,
  )
  .join('\n');

const FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';
const ACCENT = '#3b82f6';
const LINE = 'light-dark(#7c7c86, #8b8b94)';

export const DIAGRAM_STYLE = `
.d-groups, .d-labels, .d-nodes { position: absolute; left: 0; top: 0; }
.d-node, .c-default { --fill: light-dark(#ffffff, #1d1d21); --edge: light-dark(#d4d4d8, #3f3f46);
  --tint: light-dark(#18181b, #f4f4f5); }
${tones}
.d-node { position: absolute; box-sizing: border-box; display: grid; place-items: center;
  color: light-dark(#18181b, #f4f4f5); }
.d-shape { position: absolute; left: 0; top: 0; overflow: visible;
  filter: drop-shadow(0 1px 2px light-dark(rgba(0, 0, 0, .07), rgba(0, 0, 0, .45))); }
.d-shape > * { fill: var(--fill); stroke: var(--edge); stroke-width: 1.5; }
.d-shape > .fold { fill: none; }
.d-text .d-shape { filter: none; }
.d-text .d-shape > * { fill: transparent; stroke: none; }
.d-label { position: relative; box-sizing: border-box; max-width: 100%; padding: 4px 14px;
  text-align: center; white-space: pre-wrap; overflow-wrap: anywhere;
  font: 500 14px/20px ${FONT}; }
.d-text .d-label { padding: 2px 4px; font-size: 15px; font-weight: 600; color: var(--tint); }
.d-line { fill: none; stroke: ${LINE}; stroke-width: 1.5; }
.d-edge.dashed .d-line { stroke-dasharray: 6 5; }
.d-hit { fill: none; stroke: transparent; stroke-width: 14; }
.d-head { fill: ${LINE}; }
.d-head-on { fill: ${ACCENT}; }
.d-edge-label { position: absolute; max-width: 220px; transform: translate(-50%, -50%);
  padding: 1px 7px; border-radius: 6px; background: ${CANVAS_GROUND};
  color: light-dark(#52525b, #a1a1aa); font: 12px/18px ${FONT}; text-align: center;
  white-space: pre-wrap; overflow-wrap: anywhere; }
.d-group { position: absolute; box-sizing: border-box; border-radius: 16px;
  border: 1px solid light-dark(rgba(0, 0, 0, .1), rgba(255, 255, 255, .1));
  background: light-dark(rgba(0, 0, 0, .025), rgba(255, 255, 255, .03)); }
.d-group-label { position: absolute; left: 14px; top: 9px; max-width: calc(100% - 28px);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font: 600 12px/16px ${FONT}; color: light-dark(#52525b, #a1a1aa); }
.editable .d-node, .editable .d-edge, .editable .d-edge-label { cursor: default; }
.d-node.picked .d-shape > :not(.fold) { stroke: ${ACCENT}; stroke-width: 2; }
.d-node.target .d-shape > :not(.fold) { stroke: ${ACCENT}; stroke-width: 2.5; }
.d-text.picked { outline: 1.5px solid ${ACCENT}; outline-offset: 3px; border-radius: 4px; }
.d-edge.picked .d-line { stroke: ${ACCENT}; stroke-width: 2; }
.d-edge-label.picked { color: ${ACCENT}; }
.d-handle { position: absolute; z-index: 1; width: 10px; height: 10px; margin: -6px 0 0 -6px;
  border-radius: 50%; background: light-dark(#fff, #18181b); border: 1.5px solid ${ACCENT};
  opacity: 0; cursor: crosshair; transition: opacity .12s; }
.d-node:hover .d-handle, .d-node.picked .d-handle { opacity: 1; }
.d-handle[data-side="n"] { left: 50%; top: 0; }
.d-handle[data-side="e"] { left: 100%; top: 50%; }
.d-handle[data-side="s"] { left: 50%; top: 100%; }
.d-handle[data-side="w"] { left: 0; top: 50%; }
[contenteditable] { outline: none; cursor: text; min-width: 16px; min-height: 20px;
  user-select: text; -webkit-user-select: text; }
.d-edge-label[contenteditable] { box-shadow: 0 0 0 1.5px ${ACCENT}; }
.d-preview { fill: none; stroke: ${ACCENT}; stroke-width: 1.5; stroke-dasharray: 5 4; }
.d-marquee { position: absolute; border: 1px solid ${ACCENT}; border-radius: 2px;
  background: color-mix(in srgb, ${ACCENT} 10%, transparent); pointer-events: none !important; }
.d-tools { position: absolute; top: 12px; left: 50%; transform: translateX(-50%); }
.d-bar { position: absolute; max-width: calc(100% - 16px); box-sizing: border-box;
  flex-wrap: wrap; justify-content: center; }
.d-bar[hidden] { display: none; }
.d-swatch { width: 16px; height: 16px; border-radius: 50%; background: var(--fill);
  box-shadow: inset 0 0 0 1.5px var(--edge); }
.glass button[aria-pressed="true"] .d-swatch { outline: 2px solid ${ACCENT}; outline-offset: 1px; }
`;

export const DIAGRAM = String.raw`
const diagram = (source, root, editor) => {
  const SHAPES = ${JSON.stringify(DIAGRAM_SHAPES)};
  const COLORS = ${JSON.stringify(DIAGRAM_COLORS)};
  const NS = 'http://www.w3.org/2000/svg';
  const given = JSON.parse(source);
  const list = (value) => (Array.isArray(value) ? value.map((item) => Object.assign({}, item)) : []);
  const model = {
    direction: given.direction,
    nodes: list(given.nodes),
    edges: list(given.edges),
    groups: list(given.groups),
  };
  layout(model);

  const style = document.createElement('style');
  style.textContent = ${JSON.stringify(DIAGRAM_STYLE)};
  document.head.append(style);
  // What an editor hooks into the canvas: a press it takes, and a tap on nothing.
  const hooks = {};
  const view = canvas(root, editor ? {
    inset: [72, 48, 64, 48],
    claim: (event) => Boolean(hooks.claim && hooks.claim(event)),
    tapped: (event) => hooks.tapped && hooks.tapped(event),
    cancel: () => hooks.cancel && hooks.cancel(),
  } : {});
  root.setAttribute('aria-label', 'Diagram');

  const html = (tag, name, parent) => {
    const made = document.createElement(tag);
    if (name) made.className = name;
    if (parent) parent.append(made);
    return made;
  };
  const svg = (tag, attributes, parent) => {
    const made = document.createElementNS(NS, tag);
    for (const name in attributes) made.setAttribute(name, attributes[name]);
    if (parent) parent.append(made);
    return made;
  };
  const groupsLayer = html('div', 'd-groups', view.world);
  const lines = svg('svg', { class: 'd-lines' }, view.world);
  lines.style.cssText = 'position: absolute; left: 0; top: 0; width: 1px; height: 1px; overflow: visible;';
  const defs = svg('defs', {}, lines);
  for (const name of ['d-head', 'd-head-on']) {
    const marker = svg('marker', {
      id: name, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 10, markerHeight: 10,
      markerUnits: 'userSpaceOnUse', orient: 'auto-start-reverse',
    }, defs);
    svg('path', { d: 'M1 1.5L9 5L1 8.5z', class: name }, marker);
  }
  const edgesLayer = svg('g', {}, lines);
  const labelsLayer = html('div', 'd-labels', view.world);
  const nodesLayer = html('div', 'd-nodes', view.world);

  const picked = { nodes: new Set(), edge: null };
  let byId = new Map();
  const nodeEls = new Map();
  let edgeEls = [];

  const shapeOf = (node) => (SHAPES.includes(node.shape) ? node.shape : 'rounded');
  const boxOf = (node) => {
    const size = sizeOf(node);
    return [node.x - size[0] / 2, node.y - size[1] / 2, size[0], size[1]];
  };
  // The outline of a shape in a box w by h, as markup of numbers only.
  const outline = (shape, w, h) => {
    const m = 0.75;
    if (shape === 'ellipse') {
      return '<ellipse cx="' + w / 2 + '" cy="' + h / 2 + '" rx="' + (w / 2 - m) + '" ry="' + (h / 2 - m) + '"/>';
    }
    if (shape === 'diamond') {
      return '<path d="M' + w / 2 + ' ' + m + 'L' + (w - m) + ' ' + h / 2 + 'L' + w / 2 + ' ' + (h - m) + 'L' + m + ' ' + h / 2 + 'Z"/>';
    }
    if (shape === 'note') {
      const fold = Math.min(16, w / 4, h / 4);
      return '<path d="M' + m + ' ' + m + 'H' + (w - fold) + 'L' + (w - m) + ' ' + fold + 'V' + (h - m) + 'H' + m + 'Z"/>' +
        '<path class="fold" d="M' + (w - fold) + ' ' + m + 'V' + fold + 'H' + (w - m) + '"/>';
    }
    const round = shape === 'rect' ? 3 : shape === 'text' ? 4 : Math.min(14, h / 2 - 1);
    return '<rect x="' + m + '" y="' + m + '" width="' + (w - 2 * m) + '" height="' + (h - 2 * m) + '" rx="' + round + '"/>';
  };

  const paintNode = (node) => {
    const shape = shapeOf(node);
    const [x, y, w, h] = boxOf(node);
    const color = COLORS.includes(node.color) ? node.color : shape === 'note' ? 'yellow' : '';
    const element = html('div', 'd-node d-' + shape + (color ? ' c-' + color : ''), nodesLayer);
    element.dataset.id = node.id;
    element.style.cssText = 'left: ' + x + 'px; top: ' + y + 'px; width: ' + w + 'px; height: ' + h + 'px;';
    const outlined = svg('svg', { class: 'd-shape', width: w, height: h, viewBox: '0 0 ' + w + ' ' + h }, element);
    outlined.innerHTML = outline(shape, w, h);
    const label = html('div', 'd-label', element);
    label.textContent = node.label || '';
    // A diamond's words stay inside its slopes.
    if (shape === 'diamond') label.style.padding = '0 ' + Math.round(w * 0.2) + 'px';
    if (editor) {
      for (const side of ['n', 'e', 's', 'w']) html('div', 'd-handle', element).dataset.side = side;
    }
    nodeEls.set(node.id, element);
  };
  const placeNode = (node) => {
    const element = nodeEls.get(node.id);
    if (!element) return;
    const [x, y] = boxOf(node);
    element.style.left = x + 'px';
    element.style.top = y + 'px';
  };

  // Where a line leaves a node towards a point: the middle of the side that faces it, with
  // the way out of that side.
  const anchor = (node, toward) => {
    const [, , w, h] = boxOf(node);
    const dx = toward[0] - node.x;
    const dy = toward[1] - node.y;
    if (Math.abs(dx) * h > Math.abs(dy) * w) {
      return dx > 0 ? [node.x + w / 2, node.y, 1, 0] : [node.x - w / 2, node.y, -1, 0];
    }
    return dy > 0 ? [node.x, node.y + h / 2, 0, 1] : [node.x, node.y - h / 2, 0, -1];
  };
  const curve = (start, end) => {
    const reach = Math.max(24, Math.min(140, Math.hypot(end[0] - start[0], end[1] - start[1]) / 2.4));
    const a = [start[0] + start[2] * reach, start[1] + start[3] * reach];
    const b = [end[0] + end[2] * reach, end[1] + end[3] * reach];
    return {
      d: 'M' + start[0] + ' ' + start[1] + 'C' + a[0] + ' ' + a[1] + ' ' + b[0] + ' ' + b[1] + ' ' + end[0] + ' ' + end[1],
      middle: [(start[0] + 3 * a[0] + 3 * b[0] + end[0]) / 8, (start[1] + 3 * a[1] + 3 * b[1] + end[1]) / 8],
    };
  };
  const geometry = (edge) => {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) return null;
    if (from === to) {
      const [x, y, w] = boxOf(from);
      const right = x + w;
      return {
        d: 'M' + (right - 16) + ' ' + y + 'C' + (right - 16) + ' ' + (y - 48) + ' ' + (right + 48) + ' ' + (y + 16) + ' ' + right + ' ' + (y + 16),
        middle: [right + 12, y - 12],
      };
    }
    return curve(anchor(from, [to.x, to.y]), anchor(to, [from.x, from.y]));
  };
  const routeEdge = (index) => {
    const edge = model.edges[index];
    const made = edgeEls[index];
    const shape = geometry(edge);
    if (!made || !shape) return;
    const on = picked.edge === index;
    made.group.setAttribute('class', 'd-edge' + (edge.style === 'dashed' ? ' dashed' : '') + (on ? ' picked' : ''));
    made.hit.setAttribute('d', shape.d);
    made.line.setAttribute('d', shape.d);
    const head = 'url(#' + (on ? 'd-head-on' : 'd-head') + ')';
    const arrow = edge.arrow || 'end';
    if (arrow === 'none') made.line.removeAttribute('marker-end');
    else made.line.setAttribute('marker-end', head);
    if (arrow === 'both') made.line.setAttribute('marker-start', head);
    else made.line.removeAttribute('marker-start');
    if (made.label) {
      made.label.style.left = shape.middle[0] + 'px';
      made.label.style.top = shape.middle[1] + 'px';
      made.label.classList.toggle('picked', on);
    }
    made.middle = shape.middle;
  };
  const paintEdge = (edge, index) => {
    const group = svg('g', { 'data-edge': index }, edgesLayer);
    const made = { group, hit: svg('path', { class: 'd-hit' }, group), line: svg('path', { class: 'd-line' }, group) };
    if (edge.label) {
      made.label = html('div', 'd-edge-label', labelsLayer);
      made.label.dataset.edge = index;
      made.label.textContent = edge.label;
    }
    edgeEls[index] = made;
    routeEdge(index);
  };

  const PAD = 24;
  const groupBoxes = () =>
    model.groups.map((group) => {
      let box = null;
      for (const node of model.nodes) {
        if (node.group !== group.id) continue;
        const [x, y, w, h] = boxOf(node);
        box = box
          ? [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x + w), Math.max(box[3], y + h)]
          : [x, y, x + w, y + h];
      }
      return box && [box[0] - PAD, box[1] - PAD - 18, box[2] + PAD, box[3] + PAD];
    });
  const paintGroups = () => {
    groupsLayer.replaceChildren();
    groupBoxes().forEach((box, index) => {
      if (!box) return;
      const frame = html('div', 'd-group', groupsLayer);
      frame.style.cssText = 'left: ' + box[0] + 'px; top: ' + box[1] + 'px; width: ' + (box[2] - box[0]) + 'px; height: ' + (box[3] - box[1]) + 'px;';
      const label = html('div', 'd-group-label', frame);
      label.dataset.group = model.groups[index].id;
      label.textContent = model.groups[index].label || '';
    });
  };

  // What the drawing covers, for the canvas to fit: every node and every group's frame.
  view.bounds(() => {
    let box = null;
    const take = (x1, y1, x2, y2) => {
      box = box ? [Math.min(box[0], x1), Math.min(box[1], y1), Math.max(box[2], x2), Math.max(box[3], y2)] : [x1, y1, x2, y2];
    };
    for (const node of model.nodes) {
      const [x, y, w, h] = boxOf(node);
      take(x, y, x + w, y + h);
    }
    for (const frame of groupBoxes()) if (frame) take(frame[0], frame[1], frame[2], frame[3]);
    return box;
  });

  const decorate = () => {
    for (const [id, element] of nodeEls) element.classList.toggle('picked', picked.nodes.has(id));
    edgeEls.forEach((_, index) => routeEdge(index));
  };
  const draw = () => {
    byId = new Map(model.nodes.map((node) => [node.id, node]));
    nodeEls.clear();
    edgeEls = [];
    nodesLayer.replaceChildren();
    labelsLayer.replaceChildren();
    edgesLayer.replaceChildren();
    for (const node of model.nodes) paintNode(node);
    model.edges.forEach(paintEdge);
    paintGroups();
    decorate();
  };
  // After nodes moved: only places change, so nothing is built again.
  const refresh = () => {
    for (const node of model.nodes) placeNode(node);
    edgeEls.forEach((_, index) => routeEdge(index));
    paintGroups();
  };

  const NODE_KEYS = ['id', 'label', 'shape', 'x', 'y', 'width', 'height', 'color', 'group'];
  const EDGE_KEYS = ['id', 'from', 'to', 'label', 'style', 'arrow'];
  const tidy = (item, keys) => {
    const kept = {};
    for (const key of keys) {
      const value = item[key];
      if (value === undefined || value === null) continue;
      kept[key] = typeof value === 'number' ? Math.round(value) : value;
    }
    return kept;
  };
  const listed = (name, items) =>
    '  "' + name + '": [' +
    (items.length ? '\n' + items.map((item) => '    ' + JSON.stringify(item)).join(',\n') + '\n  ' : '') + ']';
  const now = () => {
    const parts = [];
    if (model.direction) parts.push('  "direction": ' + JSON.stringify(model.direction));
    parts.push(listed('nodes', model.nodes.map((node) => tidy(node, NODE_KEYS))));
    if (model.edges.length) parts.push(listed('edges', model.edges.map((edge) => tidy(edge, EDGE_KEYS))));
    if (model.groups.length) parts.push(listed('groups', model.groups.map((group) => tidy(group, ['id', 'label']))));
    return '{\n' + parts.join(',\n') + '\n}\n';
  };

  draw();
  view.fit();
  const original = now();
  if (editor) {
    editor({
      model, view, hooks, picked, html, svg, lines, labelsLayer, nodeEls,
      edges: () => edgeEls, node: (id) => byId.get(id),
      SHAPES, COLORS, shapeOf, boxOf, anchor, curve, draw, refresh, decorate,
    });
  }
  return { now, changed: () => now() !== original };
};
`;
