/**
 * A whiteboard in its frame, as script for the frame's page kept as text:
 * `const board = (source, root, editable) => { … }`, which draws the JSON in `source`
 * (`boardContentSchema`) into `root` and answers `{ now, changed }` for the one who collects the
 * edit (edit-frame.ts).
 *
 * - It is drawn as SVG on a white board, whatever the panel's theme, as paper would be. The
 *   wheel moves it, and with Ctrl or a pinch zooms it; dragging an empty place moves it too.
 * - Editing, a bar of tools makes notes, texts, boxes, ellipses, arrows, lines and pen strokes.
 *   Picked, one is dragged, resized from its corner or ends, recoloured and deleted; a double
 *   click writes its text. What is saved is the same JSON, its numbers rounded to a tenth.
 *
 * Text is set as text, never as markup. No template literal inside: this file is one already.
 */
export const BOARD = `
const board = (source, root, editable) => {
  const NS = 'http://www.w3.org/2000/svg';
  const INK = '#1f2937';
  const NOTES = ['#fef08a', '#bbf7d0', '#bfdbfe', '#fbcfe8', '#ddd6fe', '#fed7aa'];
  const INKS = ['#1f2937', '#d92d20', '#2563eb', '#16a34a', '#9333ea', '#ea580c'];
  const BOXED = ['note', 'text', 'box', 'ellipse'];
  const SIZE = { note: [180, 140], text: [220, 44], box: [180, 100], ellipse: [180, 100] };
  const given = JSON.parse(source);
  const items = Array.isArray(given.items) ? given.items : [];

  const tenth = (value) =>
    Array.isArray(value) ? value.map(tenth) : typeof value === 'number' ? Math.round(value * 10) / 10 : value;
  const now = () =>
    JSON.stringify({
      items: items.map((item) => Object.fromEntries(Object.entries(item).map(([k, v]) => [k, tenth(v)]))),
    });
  const original = now();

  const style = document.createElement('style');
  style.textContent =
    '#root { position: fixed; inset: 0; background: #fff; color: ' + INK + '; }' +
    '#root > svg { display: block; width: 100%; height: 100%; touch-action: none; user-select: none;' +
    '  -webkit-user-select: none; cursor: grab; }' +
    '.board-text { width: 100%; height: 100%; box-sizing: border-box; padding: 8px 10px; overflow: hidden;' +
    '  white-space: pre-wrap; overflow-wrap: anywhere; font: 15px/1.35 system-ui, sans-serif; color: ' + INK + '; }' +
    '.board-text.center { display: flex; align-items: center; justify-content: center; text-align: center; }' +
    '.board-text.big { padding: 2px 4px; font-size: 20px; }' +
    '.board-tools { position: absolute; top: 8px; left: 8px; right: 8px; margin: auto; width: max-content;' +
    '  max-width: calc(100% - 16px); display: flex; flex-wrap: wrap; align-items: center; gap: 2px; padding: 4px;' +
    '  border-radius: 10px; background: #fff; box-shadow: 0 1px 6px rgba(0, 0, 0, .18); }' +
    '.board-tools button { all: unset; display: grid; place-items: center; width: 28px; height: 28px;' +
    '  border-radius: 6px; cursor: pointer; color: ' + INK + '; }' +
    '.board-tools button:hover { background: #f1f5f9; }' +
    '.board-tools button[aria-pressed="true"] { background: #dbeafe; color: #1d4ed8; }' +
    '.board-tools button:disabled { opacity: .35; cursor: default; background: none; }' +
    '.board-tools .swatch { width: 16px; height: 16px; margin: 6px 3px; border-radius: 999px;' +
    '  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, .25); }' +
    '.board-tools .swatch[aria-pressed="true"] { outline: 2px solid #2563eb; outline-offset: 2px; }' +
    '.board-tools hr { width: 1px; height: 20px; margin: 0 4px; border: 0; background: #e2e8f0; }' +
    '.board-edit { position: fixed; box-sizing: border-box; margin: 0; padding: 8px 10px; resize: none;' +
    '  border: 2px solid #2563eb; border-radius: 6px; outline: none; background: #fff; color: ' + INK + ';' +
    '  font: 15px/1.35 system-ui, sans-serif; }';
  document.head.append(style);

  const el = (tag, attributes, parent) => {
    const node = document.createElementNS(NS, tag);
    for (const name in attributes) node.setAttribute(name, attributes[name]);
    if (parent) parent.append(node);
    return node;
  };
  const svg = el('svg', { role: 'img', 'aria-label': 'Whiteboard' });
  const defs = el('defs', {}, svg);
  const dots = el('pattern', { id: 'dots', width: 24, height: 24, patternUnits: 'userSpaceOnUse' }, defs);
  el('circle', { cx: 1, cy: 1, r: 1, fill: '#d4d4d8' }, dots);
  const shadow = el('filter', { id: 'shadow', x: '-10%', y: '-10%', width: '120%', height: '130%' }, defs);
  el('feDropShadow', { dx: 0, dy: 1, stdDeviation: 1.5, 'flood-opacity': 0.25 }, shadow);
  el('rect', { x: -100000, y: -100000, width: 200000, height: 200000, fill: 'url(#dots)' }, svg);
  const layer = el('g', {}, svg);
  root.replaceChildren(svg);

  const head = (color) => {
    const id = 'head-' + color.slice(1);
    if (!svg.getElementById(id)) {
      const marker = el('marker', {
        id, viewBox: '0 0 10 10', refX: 8, refY: 5, markerWidth: 7, markerHeight: 7,
        orient: 'auto-start-reverse',
      }, defs);
      el('path', { d: 'M0 0L10 5L0 10z', fill: color }, marker);
    }
    return 'url(#' + id + ')';
  };
  const ends = (item) =>
    BOXED.includes(item.kind)
      ? [[item.x, item.y], [item.x + item.w, item.y + item.h]]
      : item.kind === 'pen' ? item.points : [item.from, item.to];
  const around = (list) => {
    const xs = list.flatMap(ends).map((p) => p[0]);
    const ys = list.flatMap(ends).map((p) => p[1]);
    return xs.length ? [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] : null;
  };

  let view = (() => {
    const box = around(items);
    if (!box) return [0, 0, 960, 600];
    const [x1, y1, x2, y2] = box;
    return [x1 - 40, y1 - 40, Math.max(x2 - x1 + 80, 480), Math.max(y2 - y1 + 80, 300)];
  })();
  const show = () => svg.setAttribute('viewBox', view.join(' '));
  const point = (event) => {
    const p = new DOMPoint(event.clientX, event.clientY).matrixTransform(svg.getScreenCTM().inverse());
    return [p.x, p.y];
  };

  let tool = 'select';
  let color = null;
  let picked = null;
  let drag = null;
  const tools = document.createElement('div');

  const draw = () => {
    layer.replaceChildren();
    items.forEach((item, index) => {
      const g = el('g', { 'data-index': index }, layer);
      if (BOXED.includes(item.kind)) {
        const { x, y, w, h } = item;
        const ink = item.color || INK;
        if (item.kind === 'note') el('rect', { x, y, width: w, height: h, rx: 4, fill: item.color || NOTES[0], filter: 'url(#shadow)' }, g);
        else if (item.kind === 'box') el('rect', { x, y, width: w, height: h, rx: 6, fill: '#fff', stroke: ink, 'stroke-width': 2 }, g);
        else if (item.kind === 'ellipse') el('ellipse', { cx: x + w / 2, cy: y + h / 2, rx: w / 2, ry: h / 2, fill: '#fff', stroke: ink, 'stroke-width': 2 }, g);
        else el('rect', { x, y, width: w, height: h, fill: 'transparent' }, g);
        const holder = el('foreignObject', { x, y, width: w, height: h }, g);
        const text = document.createElement('div');
        text.className = 'board-text' + (item.kind === 'box' || item.kind === 'ellipse' ? ' center' : item.kind === 'text' ? ' big' : '');
        if (item.kind === 'text') text.style.color = ink;
        text.textContent = item.text || '';
        holder.append(text);
      } else {
        const d = 'M' + ends(item).map((p) => p.join(' ')).join('L');
        const ink = item.color || INK;
        el('path', { d, fill: 'none', stroke: 'transparent', 'stroke-width': 14, 'stroke-linecap': 'round' }, g);
        el('path', {
          d, fill: 'none', stroke: ink, 'stroke-width': item.kind === 'pen' ? 3 : 2,
          'stroke-linecap': 'round', 'stroke-linejoin': 'round',
          ...(item.kind === 'arrow' ? { 'marker-end': head(ink) } : {}),
        }, g);
      }
    });
    if (editable && picked !== null && items[picked]) {
      const item = items[picked];
      const [x1, y1, x2, y2] = around([item]);
      el('rect', {
        x: x1 - 4, y: y1 - 4, width: x2 - x1 + 8, height: y2 - y1 + 8, fill: 'none',
        stroke: '#2563eb', 'stroke-dasharray': '4 3', 'pointer-events': 'none',
      }, layer);
      const handle = { fill: '#fff', stroke: '#2563eb', 'stroke-width': 1.5 };
      if (BOXED.includes(item.kind)) {
        el('rect', { ...handle, 'data-handle': 'size', x: x2 - 1, y: y2 - 1, width: 10, height: 10, cursor: 'nwse-resize' }, layer);
      } else if (item.kind !== 'pen') {
        for (const which of ['from', 'to']) {
          el('circle', { ...handle, 'data-handle': which, cx: item[which][0], cy: item[which][1], r: 6, cursor: 'move' }, layer);
        }
      }
    }
    if (editable) paintTools();
  };

  const icon = (path) =>
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"' +
    ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + path + '"/></svg>';
  const TOOLS = [
    ['select', 'Select', 'M5 3l6 17 2.4-7.1L20 10.5z'],
    ['note', 'Note', 'M4 4h16v11l-5 5H4zM15 20v-5h5'],
    ['text', 'Text', 'M5 7V4h14v3M12 4v16M9 20h6'],
    ['box', 'Box', 'M4 5h16v14H4z'],
    ['ellipse', 'Ellipse', 'M12 5c4.4 0 8 3.1 8 7s-3.6 7-8 7-8-3.1-8-7 3.6-7 8-7z'],
    ['arrow', 'Arrow', 'M5 19L19 5M10 5h9v9'],
    ['line', 'Line', 'M5 19L19 5'],
    ['pen', 'Pen', 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z'],
  ];
  const palette = () =>
    tool === 'note' || (tool === 'select' && picked !== null && items[picked] && items[picked].kind === 'note')
      ? NOTES
      : INKS;
  const paintTools = () => {
    const colors = palette();
    const current = picked !== null && items[picked] ? items[picked].color || null : color;
    let html = '';
    for (const [name, label, path] of TOOLS) {
      html += '<button type="button" data-tool="' + name + '" aria-label="' + label + '" title="' + label +
        '" aria-pressed="' + (tool === name) + '">' + icon(path) + '</button>';
    }
    html += '<hr>';
    for (const swatch of colors) {
      html += '<button type="button" class="swatch" data-color="' + swatch + '" aria-label="Color ' + swatch +
        '" aria-pressed="' + (current === swatch) + '" style="background:' + swatch + '"></button>';
    }
    html += '<hr><button type="button" data-delete aria-label="Delete" title="Delete"' +
      (picked === null ? ' disabled' : '') + '>' + icon('M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6') + '</button>';
    tools.innerHTML = html;
  };
  const remove = () => {
    if (picked === null) return;
    items.splice(picked, 1);
    picked = null;
    draw();
  };
  const write = (index) => {
    const item = items[index];
    const shape = layer.querySelector('[data-index="' + index + '"]');
    if (!item || !shape) return;
    const box = shape.getBoundingClientRect();
    const area = document.createElement('textarea');
    area.className = 'board-edit';
    area.setAttribute('aria-label', 'Text');
    Object.assign(area.style, {
      left: box.left + 'px', top: box.top + 'px',
      width: Math.max(box.width, 140) + 'px', height: Math.max(box.height, 44) + 'px',
    });
    area.value = item.text || '';
    root.append(area);
    area.focus();
    let done = false;
    const finish = (keep) => {
      if (done) return;
      done = true;
      if (keep) {
        if (area.value) item.text = area.value;
        else delete item.text;
      }
      area.remove();
      // A text with nothing written is nothing.
      if (item.kind === 'text' && !item.text) {
        items.splice(items.indexOf(item), 1);
        picked = null;
      }
      draw();
    };
    area.addEventListener('blur', () => finish(true));
    area.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Escape') finish(false);
      else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) finish(true);
    });
  };
  const moved = (item, from, dx, dy) => {
    const shift = (p) => [p[0] + dx, p[1] + dy];
    if (BOXED.includes(item.kind)) { item.x = from.x + dx; item.y = from.y + dy; }
    else if (item.kind === 'pen') item.points = from.points.map(shift);
    else { item.from = shift(from.from); item.to = shift(from.to); }
  };

  svg.addEventListener('wheel', (event) => {
    event.preventDefault();
    const scale = svg.getScreenCTM().a;
    if (event.ctrlKey || event.metaKey) {
      const [px, py] = point(event);
      const factor = Math.min(Math.max(Math.exp(event.deltaY * 0.01), 0.5), 2);
      const width = Math.min(Math.max(view[2] * factor, 120), 40000);
      const k = width / view[2];
      view = [px - (px - view[0]) * k, py - (py - view[1]) * k, view[2] * k, view[3] * k];
    } else {
      view = [view[0] + event.deltaX / scale, view[1] + event.deltaY / scale, view[2], view[3]];
    }
    show();
  }, { passive: false });

  svg.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return;
    const p = point(event);
    const handle = event.target.closest('[data-handle]');
    const hit = event.target.closest('[data-index]');
    svg.setPointerCapture(event.pointerId);
    if (editable && handle && picked !== null) {
      drag = { kind: handle.dataset.handle, start: p, item: structuredClone(items[picked]) };
      return;
    }
    if (!editable || tool === 'select') {
      if (editable && hit) {
        picked = Number(hit.dataset.index);
        drag = { kind: 'move', start: p, item: structuredClone(items[picked]) };
      } else {
        if (editable) picked = null;
        drag = { kind: 'pan', start: [event.clientX, event.clientY], view: view.slice() };
      }
      if (editable) draw();
      return;
    }
    const made = BOXED.includes(tool)
      ? { kind: tool, x: p[0], y: p[1], w: 1, h: 1 }
      : tool === 'pen' ? { kind: 'pen', points: [p, p] } : { kind: tool, from: p, to: p };
    if (color && palette().includes(color)) made.color = color;
    items.push(made);
    picked = items.length - 1;
    drag = { kind: 'make', start: p };
    draw();
  });
  svg.addEventListener('pointermove', (event) => {
    if (!drag) return;
    if (drag.kind === 'pan') {
      const scale = svg.getScreenCTM().a;
      view = [
        drag.view[0] - (event.clientX - drag.start[0]) / scale,
        drag.view[1] - (event.clientY - drag.start[1]) / scale,
        view[2], view[3],
      ];
      show();
      return;
    }
    const p = point(event);
    const dx = p[0] - drag.start[0];
    const dy = p[1] - drag.start[1];
    const item = items[picked];
    if (drag.kind === 'move') moved(item, drag.item, dx, dy);
    else if (drag.kind === 'size') {
      item.w = Math.max(24, drag.item.w + dx);
      item.h = Math.max(24, drag.item.h + dy);
    } else if (drag.kind === 'from' || drag.kind === 'to') {
      item[drag.kind] = [drag.item[drag.kind][0] + dx, drag.item[drag.kind][1] + dy];
    } else if (BOXED.includes(item.kind)) {
      item.x = Math.min(drag.start[0], p[0]);
      item.y = Math.min(drag.start[1], p[1]);
      item.w = Math.max(Math.abs(dx), 1);
      item.h = Math.max(Math.abs(dy), 1);
    } else if (item.kind === 'pen') {
      const last = item.points[item.points.length - 1];
      if (Math.hypot(p[0] - last[0], p[1] - last[1]) > 2) item.points.push(p);
    } else item.to = p;
    draw();
  });
  const up = () => {
    if (drag && drag.kind === 'make') {
      const item = items[picked];
      if (BOXED.includes(item.kind) && item.w < 12 && item.h < 12) [item.w, item.h] = SIZE[item.kind];
      if ((item.kind === 'arrow' || item.kind === 'line') &&
        Math.hypot(item.to[0] - item.from[0], item.to[1] - item.from[1]) < 4) {
        item.to = [item.from[0] + 160, item.from[1]];
      }
      tool = 'select';
      draw();
      if (item.kind === 'note' || item.kind === 'text') write(picked);
    }
    drag = null;
  };
  svg.addEventListener('pointerup', up);
  svg.addEventListener('pointercancel', up);

  if (editable) {
    tools.className = 'board-tools';
    root.append(tools);
    // Pressed without taking the focus, so a text being written keeps it until it is done.
    tools.addEventListener('mousedown', (event) => event.preventDefault());
    tools.addEventListener('click', (event) => {
      const button = event.target.closest('button');
      if (!button) return;
      if (button.dataset.tool) {
        tool = button.dataset.tool;
        if (tool !== 'select') picked = null;
      } else if (button.dataset.color) {
        color = button.dataset.color;
        if (picked !== null && items[picked]) items[picked].color = color;
      } else if ('delete' in button.dataset) return remove();
      draw();
    });
    // The first click of the two picked it.
    svg.addEventListener('dblclick', () => {
      if (picked !== null && items[picked] && BOXED.includes(items[picked].kind)) write(picked);
    });
    addEventListener('keydown', (event) => {
      if (event.key === 'Delete' || event.key === 'Backspace') remove();
      else if (event.key === 'Escape') {
        picked = null;
        tool = 'select';
        draw();
      }
    });
  }
  show();
  draw();

  return { now, changed: () => now() !== original };
};
`;
