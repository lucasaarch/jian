/**
 * Building a deck's slide by hand, over the page editor (edit-frame.ts), as script for the
 * editing frame kept as text: `const buildSlide = (api) => { … }`, which `editPage` calls with
 * what it shares (`mark`, `release`, the block being typed in, the panel's first options).
 *
 * - The panel asks for a text box or a picture (`{ insert }`, ARTIFACT_EDIT_MESSAGE). Either is
 *   placed in the middle of the canvas, absolutely, over what the agent drew, and marked
 *   `data-jian-box` so it can be moved and sized again in a later edit. That mark stays in what
 *   is saved; everything drawn here to handle it is `data-jian-edit` and is taken out.
 * - A picture comes as a `data:` URL the panel read from a file the owner picked. The frame loads
 *   nothing, so only a picture written in the page itself can be shown, now or in a presentation.
 * - A press on a box picks it and drags it. A click on a text box types in it, as on any text; the
 *   grip over a picked box still moves it while it is typed in. Its corners size it, a picture
 *   keeping its proportions. Delete or the bin removes it, the arrows nudge it.
 * - A text that says "Click to add" (`data-jian-placeholder`, as a new slide's layout writes it)
 *   is selected whole when clicked, and loses that mark once typed over.
 *
 * Positions are in the slide's own pixels: the frame is laid out at the canvas size and scaled
 * outside, so the pointer's moves inside it need no scaling. Only the handles are drawn larger as
 * the slide is drawn smaller (`--k`), to stay big enough to hit.
 *
 * No template literal inside: this file is one already.
 */
const STYLE = `
#jian-box-frame { all: initial; position: fixed; z-index: 2147483646; box-sizing: border-box;
  pointer-events: none; border: calc(1.5px * var(--k)) solid #4c8dff; }
#jian-box-frame[hidden] { display: none; }
#jian-box-frame [data-corner] { all: initial; position: absolute; box-sizing: border-box;
  width: calc(12px * var(--k)); height: calc(12px * var(--k)); background: #fff;
  border: calc(1.5px * var(--k)) solid #4c8dff; border-radius: calc(3px * var(--k));
  pointer-events: auto; }
#jian-box-frame [data-corner="nw"] { left: calc(-6px * var(--k)); top: calc(-6px * var(--k));
  cursor: nwse-resize; }
#jian-box-frame [data-corner="ne"] { right: calc(-6px * var(--k)); top: calc(-6px * var(--k));
  cursor: nesw-resize; }
#jian-box-frame [data-corner="sw"] { left: calc(-6px * var(--k)); bottom: calc(-6px * var(--k));
  cursor: nesw-resize; }
#jian-box-frame [data-corner="se"] { right: calc(-6px * var(--k)); bottom: calc(-6px * var(--k));
  cursor: nwse-resize; }
#jian-box-frame .tools { all: initial; position: absolute; left: 0; display: flex;
  gap: calc(2px * var(--k)); padding: calc(3px * var(--k)); border-radius: calc(9px * var(--k));
  background: rgba(28, 28, 30, .94); box-shadow: 0 6px 24px rgba(0, 0, 0, .35);
  pointer-events: auto; }
#jian-box-frame .tools button { all: unset; display: grid; place-items: center;
  width: calc(26px * var(--k)); height: calc(26px * var(--k)); border-radius: calc(6px * var(--k));
  color: #fff; cursor: pointer; }
#jian-box-frame .tools button:hover { background: rgba(255, 255, 255, .16); }
#jian-box-frame .tools [data-grip] { cursor: move; }
#jian-box-frame svg { width: calc(15px * var(--k)); height: calc(15px * var(--k)); }
`;

export const SLIDE_BUILDER = String.raw`
const buildSlide = (api) => {
  const MIN = 24;
  const PICTURE = /^data:image\/(png|jpeg|gif|webp|avif|svg\+xml);base64,[a-z0-9+/=]+$/i;
  let scale = api.options && api.options.scale > 0 ? api.options.scale : 1;
  let chosen = null;
  let gesture = null;
  // A press that moved something ends in a click, which must not then start typing.
  let swallow = false;

  const elementOf = (node) => (node && node.nodeType !== 1 ? node.parentElement : node);
  const ours = (node) => Boolean(elementOf(node) && elementOf(node).closest('[data-jian-edit]'));
  const boxOf = (node) => {
    const element = elementOf(node);
    return element ? element.closest('[data-jian-box]') : null;
  };
  const glyph = (path) =>
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"' +
    ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + path +
    '"/></svg>';

  const style = document.createElement('style');
  style.setAttribute('data-jian-edit', '');
  style.textContent = ${JSON.stringify(STYLE)};
  document.head.append(style);
  const frame = document.createElement('div');
  frame.id = 'jian-box-frame';
  frame.setAttribute('data-jian-edit', '');
  frame.hidden = true;
  for (const corner of ['nw', 'ne', 'sw', 'se']) {
    const handle = document.createElement('span');
    handle.setAttribute('data-corner', corner);
    frame.append(handle);
  }
  const tools = document.createElement('div');
  tools.className = 'tools';
  tools.innerHTML =
    '<button type="button" data-grip title="Drag to move" aria-label="Move">' +
    glyph('M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20') +
    '</button><button type="button" data-remove title="Delete" aria-label="Delete">' +
    glyph('M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6') + '</button>';
  frame.append(tools);
  // Beside the body, as the bar of formatting is: the page lays out and counts what it did.
  document.documentElement.append(frame);

  const place = () => {
    if (!chosen || !chosen.isConnected) {
      chosen = null;
      frame.hidden = true;
      return;
    }
    const k = 1 / scale;
    const box = chosen.getBoundingClientRect();
    frame.hidden = false;
    frame.style.setProperty('--k', String(k));
    frame.style.left = box.left + 'px';
    frame.style.top = box.top + 'px';
    frame.style.width = box.width + 'px';
    frame.style.height = box.height + 'px';
    // Over the box when there is room above it, under it when not, or while it is typed in:
    // the bar of formatting stands over it then.
    const over = box.top > 44 * k && !typing();
    tools.style.top = over ? -40 * k + 'px' : box.height + 10 * k + 'px';
  };
  const choose = (box) => {
    chosen = box;
    place();
  };
  const remove = () => {
    if (!chosen) return;
    if (api.active() && chosen.contains(api.active())) api.release();
    chosen.remove();
    choose(null);
    api.mark();
  };
  const typing = () => Boolean(chosen && api.active() && chosen.contains(api.active()));

  const insert = (what) => {
    let box;
    if (what.text === true) {
      box = document.createElement('div');
      box.setAttribute('data-jian-box', 'text');
      box.setAttribute('data-jian-placeholder', '');
      box.textContent = 'Click to add text';
      box.style.cssText =
        'position: absolute; z-index: 10; box-sizing: border-box; margin: 0; width: 560px;' +
        ' min-height: 64px; padding: 8px 12px; font-size: 36px; line-height: 1.3;' +
        ' text-align: left; overflow-wrap: break-word;';
    } else if (typeof what.image === 'string' && PICTURE.test(what.image)) {
      const width = Number(what.width) > 0 ? Number(what.width) : 640;
      const height = Number(what.height) > 0 ? Number(what.height) : 360;
      // Fits well inside the canvas at first; the owner sizes it from there.
      const fit = Math.min(1, (innerWidth * 0.6) / width, (innerHeight * 0.6) / height);
      box = document.createElement('img');
      box.setAttribute('data-jian-box', 'image');
      box.setAttribute('alt', '');
      box.setAttribute('src', what.image);
      box.style.cssText =
        'position: absolute; z-index: 10; box-sizing: border-box; margin: 0; max-width: none;' +
        ' object-fit: contain; width: ' + Math.round(width * fit) + 'px; height: ' +
        Math.round(height * fit) + 'px;';
    } else {
      return;
    }
    document.body.append(box);
    // Centred on the canvas whatever box holds it, and a step aside from one already there.
    const step = 24 * (document.querySelectorAll('[data-jian-box]').length - 1) % 120;
    box.style.left = '0px';
    box.style.top = '0px';
    const at = box.getBoundingClientRect();
    box.style.left = Math.round((innerWidth - at.width) / 2 - at.left + step) + 'px';
    box.style.top = Math.round((innerHeight - at.height) / 2 - at.top + step) + 'px';
    api.release();
    choose(box);
    api.mark();
  };

  const start = (event, kind, corner) => {
    gesture = {
      kind,
      corner,
      pointer: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: parseFloat(chosen.style.left) || 0,
      top: parseFloat(chosen.style.top) || 0,
      width: chosen.offsetWidth,
      height: chosen.offsetHeight,
      moved: false,
    };
    if (event.target.setPointerCapture) event.target.setPointerCapture(event.pointerId);
  };

  addEventListener('pointerdown', (event) => {
    swallow = false;
    if (event.button !== 0) return;
    const element = elementOf(event.target);
    const corner = element && element.closest('[data-corner]');
    if (corner && chosen) {
      event.preventDefault();
      return start(event, 'size', corner.getAttribute('data-corner'));
    }
    if (element && element.closest('[data-grip]') && chosen) {
      event.preventDefault();
      return start(event, 'move');
    }
    // The bar of formatting and these tools act on what is picked; they pick nothing.
    if (ours(event.target)) return;
    const box = boxOf(event.target);
    choose(box);
    if (!box || typing()) return;
    start(event, 'move');
  }, true);

  addEventListener('pointermove', (event) => {
    if (!gesture || event.pointerId !== gesture.pointer || !chosen) return;
    const dx = event.clientX - gesture.x;
    const dy = event.clientY - gesture.y;
    if (!gesture.moved) {
      if (Math.abs(dx) + Math.abs(dy) < 3) return;
      gesture.moved = true;
      // Typing elsewhere ends; typing in the box being moved goes on.
      if (!typing()) api.release();
    }
    // The press would otherwise select the words it passes over.
    if (!typing()) getSelection().removeAllRanges();
    if (gesture.kind === 'move') {
      chosen.style.left = Math.round(gesture.left + dx) + 'px';
      chosen.style.top = Math.round(gesture.top + dy) + 'px';
    } else {
      const east = gesture.corner.includes('e');
      const south = gesture.corner.includes('s');
      let width = gesture.width + (east ? dx : -dx);
      let height = gesture.height + (south ? dy : -dy);
      if (chosen.tagName === 'IMG') {
        const ratio = gesture.width / gesture.height;
        if (Math.abs(width - gesture.width) >= Math.abs(height - gesture.height) * ratio) {
          height = width / ratio;
        } else {
          width = height * ratio;
        }
      }
      width = Math.max(MIN, Math.round(width));
      height = Math.max(MIN, Math.round(height));
      chosen.style.width = width + 'px';
      // A text box grows with what is typed in it: its height is only where it starts.
      chosen.style[chosen.tagName === 'IMG' ? 'height' : 'minHeight'] = height + 'px';
      chosen.style.left = Math.round(east ? gesture.left : gesture.left + gesture.width - width) + 'px';
      chosen.style.top = Math.round(south ? gesture.top : gesture.top + gesture.height - height) + 'px';
    }
    place();
  }, true);

  const finish = (event) => {
    if (!gesture || event.pointerId !== gesture.pointer) return;
    if (gesture.moved) {
      swallow = true;
      api.mark();
    }
    gesture = null;
    place();
  };
  addEventListener('pointerup', finish, true);
  addEventListener('pointercancel', finish, true);
  // A picture is not dragged out as a file.
  addEventListener('dragstart', (event) => {
    if (boxOf(event.target)) event.preventDefault();
  }, true);

  // Ahead of the page editor's own: what is handled here never reaches it.
  addEventListener('click', (event) => {
    if (swallow) {
      swallow = false;
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    if (frame.contains(event.target)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const element = elementOf(event.target);
      if (element && element.closest('[data-remove]')) remove();
      return;
    }
    const element = elementOf(event.target);
    const placeholder = element && element.closest('[data-jian-placeholder]');
    // After the editor has opened what was clicked for typing, which this click is about to do.
    setTimeout(() => {
      place();
      const active = api.active();
      if (!placeholder || !active || !active.contains(placeholder)) return;
      if (!placeholder.hasAttribute('data-jian-placeholder')) return;
      const range = document.createRange();
      range.selectNodeContents(placeholder);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });
  }, true);

  addEventListener('input', (event) => {
    const at = elementOf(getSelection().anchorNode) || elementOf(event.target);
    const placeholder = at && at.closest('[data-jian-placeholder]');
    if (placeholder) placeholder.removeAttribute('data-jian-placeholder');
    place();
  }, true);

  addEventListener('keydown', (event) => {
    if (!chosen || typing() || ours(event.target)) return;
    const by = event.shiftKey ? 10 : 1;
    const nudge = { ArrowLeft: [-by, 0], ArrowRight: [by, 0], ArrowUp: [0, -by], ArrowDown: [0, by] }[event.key];
    if (event.key === 'Delete' || event.key === 'Backspace') {
      remove();
    } else if (event.key === 'Escape') {
      choose(null);
    } else if (nudge) {
      chosen.style.left = (parseFloat(chosen.style.left) || 0) + nudge[0] + 'px';
      chosen.style.top = (parseFloat(chosen.style.top) || 0) + nudge[1] + 'px';
      api.mark();
      place();
    } else {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);

  addEventListener('scroll', place, true);
  addEventListener('resize', place);
  addEventListener('message', (event) => {
    const ask = event.source === parent && event.data && event.data[api.KEY];
    if (!ask) return;
    if (typeof ask.scale === 'number' && ask.scale > 0) {
      scale = ask.scale;
      place();
    }
    if (ask.insert && typeof ask.insert === 'object') insert(ask.insert);
  });
};
`;
