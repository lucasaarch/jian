import { CANVAS_DOT, CANVAS_GROUND, CANVAS_SPACING } from './frame-style.js';

/**
 * The infinite canvas a diagram is drawn on, a native one or a Mermaid one, as script for the
 * frame's page kept as text: `const canvas = (root, options) => { … }` turns `root` into a view
 * that pans and zooms over `world`, where the diagram is drawn at full size.
 *
 * - It opens fitted and centred on what `bounds` says the drawing covers, never enlarged past
 *   its full size, and fits again as the frame is resized until the reader moves it.
 * - Panned by dragging (an empty place, or anywhere with Space held or the middle button), by
 *   a trackpad's two fingers or a wheel; zoomed by Ctrl or Cmd with the wheel, a pinch (the
 *   wheel with Ctrl, Safari's gestures, or two fingers on a screen), + and −, and the buttons in
 *   the corner. 0 fits it again.
 * - The dots are the component canvas's (frame-style.ts) and move with the drawing; past a zoom
 *   where they would blur into a tint, every other one is left out.
 * - `options.claim(event)` is how an editor keeps a press on something of its own from
 *   panning; `options.tapped(event)` hears a press on the canvas that never moved.
 *
 * It reaches nothing and posts nothing. No template literal inside: this file is one already.
 */
const STYLE = `
#root.canvas { position: fixed; inset: 0; overflow: hidden; touch-action: none; cursor: grab;
  user-select: none; -webkit-user-select: none; outline: none;
  background-color: ${CANVAS_GROUND}; background-image: ${CANVAS_DOT}; }
#root.canvas.panning, #root.canvas.panning * { cursor: grabbing !important; }
#failure:not(:empty) { position: fixed; z-index: 3; top: 0; left: 0; right: 0; }
.canvas-world { position: absolute; left: 0; top: 0; width: 0; height: 0; transform-origin: 0 0; }
.canvas-world svg { max-width: none; }
.canvas-overlay { position: absolute; inset: 0; pointer-events: none; }
.canvas-overlay > * { pointer-events: auto; cursor: default; }
.glass { display: flex; align-items: center; gap: 2px; padding: 3px; border-radius: 12px;
  background: light-dark(rgba(255, 255, 255, .8), rgba(30, 30, 33, .8));
  -webkit-backdrop-filter: blur(14px) saturate(1.5); backdrop-filter: blur(14px) saturate(1.5);
  border: 1px solid light-dark(rgba(0, 0, 0, .08), rgba(255, 255, 255, .1));
  box-shadow: 0 6px 24px light-dark(rgba(0, 0, 0, .08), rgba(0, 0, 0, .45));
  color: light-dark(#18181b, #f4f4f5); font: 12px/1 system-ui, -apple-system, "Segoe UI", sans-serif; }
.glass button { all: unset; box-sizing: border-box; display: grid; place-items: center;
  min-width: 28px; height: 28px; padding: 0 6px; border-radius: 999px; cursor: pointer;
  color: light-dark(#52525b, #a1a1aa); font-variant-numeric: tabular-nums; }
.glass button:hover { background: light-dark(rgba(0, 0, 0, .06), rgba(255, 255, 255, .08));
  color: light-dark(#18181b, #f4f4f5); }
.glass button:focus-visible { outline: 2px solid #3b82f6; outline-offset: -2px; }
.glass button[aria-pressed="true"] { background: light-dark(rgba(0, 0, 0, .09), rgba(255, 255, 255, .13));
  color: light-dark(#18181b, #f4f4f5); }
.glass button:disabled { opacity: .35; cursor: default; background: none; }
.glass hr { width: 1px; height: 18px; margin: 0 3px; border: 0;
  background: light-dark(rgba(0, 0, 0, .1), rgba(255, 255, 255, .12)); }
.canvas-zoom { position: absolute; right: 12px; bottom: 12px; }
.canvas-zoom .percent { min-width: 48px; }
`;

export const CANVAS = `
const canvasIcon = (path, size) =>
  '<svg viewBox="0 0 24 24" width="' + (size || 16) + '" height="' + (size || 16) +
  '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"' +
  ' stroke-linejoin="round" aria-hidden="true"><path d="' + path + '"/></svg>';

const canvas = (root, options) => {
  options = options || {};
  const MIN = 0.1;
  const MAX = 4;
  const SPACING = ${CANVAS_SPACING};
  const style = document.createElement('style');
  style.textContent = ${JSON.stringify(STYLE)};
  document.head.append(style);
  root.classList.add('canvas');
  const world = document.createElement('div');
  world.className = 'canvas-world';
  const overlay = document.createElement('div');
  overlay.className = 'canvas-overlay';
  root.replaceChildren(world, overlay);

  // A point of the drawing at (wx, wy) is on screen at (wx * k + x, wy * k + y) in the root.
  let x = 0;
  let y = 0;
  let k = 1;
  // Until the reader moves it, the view follows the frame's size; after, it stays theirs.
  let moved = false;
  let bounds = () => null;
  const watchers = [];
  const clamp = (value) => Math.min(MAX, Math.max(MIN, value));

  const button = (label, glyph, act) => {
    const made = document.createElement('button');
    made.type = 'button';
    made.title = label;
    made.setAttribute('aria-label', label);
    made.innerHTML = glyph;
    made.addEventListener('click', act);
    return made;
  };
  const zoom = document.createElement('div');
  zoom.className = 'glass canvas-zoom';
  zoom.setAttribute('role', 'toolbar');
  zoom.setAttribute('aria-label', 'Zoom');
  const percent = button('Actual size', '100%', () => zoomAt(1 / k));
  percent.classList.add('percent');
  zoom.append(
    button('Zoom out', canvasIcon('M5 12h14'), () => zoomAt(1 / 1.25)),
    percent,
    button('Zoom in', canvasIcon('M5 12h14M12 5v14'), () => zoomAt(1.25)),
    button('Fit', canvasIcon('M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2'), () => fit()),
  );
  overlay.append(zoom);

  const apply = () => {
    world.style.transform = 'translate(' + x + 'px, ' + y + 'px) scale(' + k + ')';
    let step = SPACING * k;
    while (step < 9) step *= 2;
    while (step > 40) step /= 2;
    root.style.backgroundSize = step + 'px ' + step + 'px';
    root.style.backgroundPosition = (x + step / 2) + 'px ' + (y + step / 2) + 'px';
    percent.textContent = Math.round(k * 100) + '%';
    for (const watcher of watchers) watcher();
  };
  // Zooms by a factor around a point of the root, the middle when none is given: what is under
  // the pointer stays under it.
  const zoomAt = (factor, at) => {
    const point = at || [root.clientWidth / 2, root.clientHeight / 2];
    const next = clamp(k * factor);
    x = point[0] - ((point[0] - x) * next) / k;
    y = point[1] - ((point[1] - y) * next) / k;
    k = next;
    moved = true;
    apply();
  };
  const local = (event) => {
    const box = root.getBoundingClientRect();
    return [event.clientX - box.left, event.clientY - box.top];
  };
  const fit = () => {
    const box = bounds();
    const width = root.clientWidth;
    const height = root.clientHeight;
    moved = false;
    if (!box || !width || !height) {
      k = 1;
      x = width / 2;
      y = height / 2;
      return apply();
    }
    // top, right, bottom, left: an editor keeps its toolbar clear.
    const inset = options.inset || [40, 40, 56, 40];
    const room = [Math.max(40, width - inset[1] - inset[3]), Math.max(40, height - inset[0] - inset[2])];
    const across = Math.max(1, box[2] - box[0]);
    const down = Math.max(1, box[3] - box[1]);
    k = clamp(Math.min(1, room[0] / across, room[1] / down));
    x = inset[3] + room[0] / 2 - (box[0] + across / 2) * k;
    y = inset[0] + room[1] / 2 - (box[1] + down / 2) * k;
    apply();
  };

  let size = [root.clientWidth, root.clientHeight];
  addEventListener('resize', () => {
    const now = [root.clientWidth, root.clientHeight];
    if (!moved) fit();
    else {
      x += (now[0] - size[0]) / 2;
      y += (now[1] - size[1]) / 2;
      apply();
    }
    size = now;
  });

  const typing = (event) =>
    event.target && (event.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName));
  let space = false;
  addEventListener('keydown', (event) => {
    if (typing(event) || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.code === 'Space') {
      space = true;
      event.preventDefault();
    } else if (event.key === '+' || event.key === '=') zoomAt(1.25);
    else if (event.key === '-' || event.key === '_') zoomAt(1 / 1.25);
    else if (event.key === '0') fit();
  });
  addEventListener('keyup', (event) => {
    if (event.code === 'Space') space = false;
  });
  addEventListener('blur', () => (space = false));

  let pan = null;
  const touches = new Map();
  const ours = (event) => !overlay.contains(event.target) || event.target === overlay;
  root.addEventListener('pointerdown', (event) => {
    if (!ours(event)) return;
    if (event.pointerType === 'touch') {
      touches.set(event.pointerId, [event.clientX, event.clientY]);
      if (touches.size === 2) {
        pan = null;
        if (options.cancel) options.cancel();
        return;
      }
    }
    const forced = space || event.button === 1;
    if (!forced && (event.button !== 0 || (options.claim && options.claim(event)))) return;
    event.preventDefault();
    pan = { id: event.pointerId, from: [event.clientX, event.clientY], at: [x, y], far: false };
    root.setPointerCapture(event.pointerId);
    root.classList.add('panning');
  });
  root.addEventListener('pointermove', (event) => {
    if (touches.has(event.pointerId) && touches.size === 2) {
      const before = [...touches.values()];
      touches.set(event.pointerId, [event.clientX, event.clientY]);
      const after = [...touches.values()];
      const middle = (pair) => [(pair[0][0] + pair[1][0]) / 2, (pair[0][1] + pair[1][1]) / 2];
      const apart = (pair) => Math.hypot(pair[0][0] - pair[1][0], pair[0][1] - pair[1][1]) || 1;
      const was = middle(before);
      const is = middle(after);
      x += is[0] - was[0];
      y += is[1] - was[1];
      const box = root.getBoundingClientRect();
      zoomAt(apart(after) / apart(before), [is[0] - box.left, is[1] - box.top]);
      return;
    }
    if (!pan || event.pointerId !== pan.id) return;
    const dx = event.clientX - pan.from[0];
    const dy = event.clientY - pan.from[1];
    if (!pan.far && Math.hypot(dx, dy) < 3) return;
    pan.far = true;
    x = pan.at[0] + dx;
    y = pan.at[1] + dy;
    moved = true;
    apply();
  });
  const end = (event) => {
    touches.delete(event.pointerId);
    if (!pan || event.pointerId !== pan.id) return;
    const tap = !pan.far && event.type === 'pointerup';
    pan = null;
    root.classList.remove('panning');
    if (tap && options.tapped) options.tapped(event);
  };
  root.addEventListener('pointerup', end);
  root.addEventListener('pointercancel', end);

  root.addEventListener('wheel', (event) => {
    if (!ours(event)) return;
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? root.clientHeight : 1;
    if (event.ctrlKey || event.metaKey) {
      // A pinch arrives as small steps, a wheel's notch as a large one: each is held to a step
      // that zooms by a quarter at most.
      const step = Math.max(-25, Math.min(25, event.deltaY * unit));
      zoomAt(Math.exp(-step * 0.01), local(event));
    } else {
      x -= event.deltaX * unit;
      y -= event.deltaY * unit;
      moved = true;
      apply();
    }
  }, { passive: false });
  // Safari's pinch is a gesture, not a wheel.
  let gesture = 1;
  root.addEventListener('gesturestart', (event) => {
    event.preventDefault();
    gesture = 1;
  });
  root.addEventListener('gesturechange', (event) => {
    event.preventDefault();
    zoomAt(event.scale / gesture, local(event));
    gesture = event.scale;
  });

  apply();
  return {
    root,
    world,
    overlay,
    fit,
    zoomAt,
    scale: () => k,
    // Where a point of the screen is in the drawing, and back.
    toWorld: (clientX, clientY) => {
      const box = root.getBoundingClientRect();
      return [(clientX - box.left - x) / k, (clientY - box.top - y) / k];
    },
    toScreen: (wx, wy) => [wx * k + x, wy * k + y],
    middle: () => [(root.clientWidth / 2 - x) / k, (root.clientHeight / 2 - y) / k],
    bounds: (given) => (bounds = given),
    watch: (watcher) => watchers.push(watcher),
  };
};
`;
