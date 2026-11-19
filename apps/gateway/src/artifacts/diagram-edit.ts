/**
 * The owner's hands on a diagram, as script for the frame's page kept as text:
 * `const diagramEditor = (ctx) => { … }`, handed what diagram-frame.ts drew and changing its
 * `model` in place. Nothing here saves: the frame answers the JSON when the panel collects it.
 *
 * - A press on a node picks it (Shift adds or takes it away) and dragging moves every node
 *   picked; Shift and a drag on the canvas picks what the box touches. A drag on the canvas
 *   alone pans it, as everywhere else.
 * - A node's handles, one a side, draw a line to the node it is dropped on, or to a new node
 *   where it is dropped on nothing.
 * - A double click writes a node's, an edge's or a group's label in place (Enter keeps it,
 *   Shift+Enter breaks the line, Escape puts it back); on the canvas it adds a node there.
 * - The bar at the top adds a node of each shape, and undoes and redoes. A bar over what is
 *   picked changes a node's shape and colour, or an edge's line, arrows and label, and deletes.
 * - Delete or Backspace removes what is picked, a node with its edges; Cmd or Ctrl with Z, or
 *   with Shift, undoes and redoes; with A picks every node; arrows nudge, by 10 with Shift.
 *
 * Every label is set as text. No template literal inside: this file is one already.
 */
export const DIAGRAM_EDIT = String.raw`
const diagramEditor = (ctx) => {
  const { model, view, hooks, picked, html, svg } = ctx;
  const root = view.root;
  root.classList.add('editable');
  root.tabIndex = -1;
  const LABEL_MAX = 300;
  const EDGE_LABEL_MAX = 120;
  const ICON = {
    rect: 'M4 5h16v14H4z',
    rounded: 'M8 5h8a4 4 0 0 1 4 4v6a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V9a4 4 0 0 1 4-4z',
    ellipse: 'M12 5c5 0 9 3.1 9 7s-4 7-9 7-9-3.1-9-7 4-7 9-7z',
    diamond: 'M12 3l9 9-9 9-9-9z',
    note: 'M15 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9zM15 3v6h6',
    text: 'M4 7V4h16v3M9 20h6M12 4v16',
    undo: 'M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
    redo: 'm15 14 5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13',
    trash: 'M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2',
    solid: 'M4 12h16',
    dashed: 'M3 12h4M10 12h4M17 12h4',
    end: 'M4 12h15M14 7l5 5-5 5',
    both: 'M5 12h14M9 7l-5 5 5 5M15 7l5 5-5 5',
    none: 'M4 12h16M4 8v8M20 8v8',
    label: 'M14 4v16M10 20h8M4 8V5h20v3',
  };
  const SHAPE_NAME = { rect: 'Rectangle', rounded: 'Rounded box', ellipse: 'Ellipse', diamond: 'Decision', note: 'Note', text: 'Text' };
  const typing = (event) =>
    event.target && (event.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName));
  const button = (label, glyph, act, pressed) => {
    const made = document.createElement('button');
    made.type = 'button';
    made.title = label;
    made.setAttribute('aria-label', label);
    if (pressed !== undefined) made.setAttribute('aria-pressed', String(pressed));
    made.innerHTML = glyph;
    made.addEventListener('click', act);
    return made;
  };
  const rule = () => document.createElement('hr');

  // History: the model as it was before each change, and what was undone.
  const past = [];
  const future = [];
  const snapshot = () => JSON.stringify({ nodes: model.nodes, edges: model.edges, groups: model.groups });
  const record = () => {
    past.push(snapshot());
    if (past.length > 200) past.shift();
    future.length = 0;
    syncTools();
  };
  const restore = (text) => {
    const was = JSON.parse(text);
    model.nodes = was.nodes;
    model.edges = was.edges;
    model.groups = was.groups;
    picked.nodes = new Set();
    picked.edge = null;
    ctx.draw();
    syncTools();
    syncBar();
  };
  const undo = () => {
    if (!past.length) return;
    finish(true);
    future.push(snapshot());
    restore(past.pop());
  };
  const redo = () => {
    if (!future.length) return;
    finish(true);
    past.push(snapshot());
    restore(future.pop());
  };

  const select = (ids, edge) => {
    picked.nodes = new Set(ids);
    picked.edge = edge === undefined ? null : edge;
    ctx.decorate();
    syncBar();
  };

  // A label written in place: a node's, an edge's or a group's.
  let editing = null;
  const finish = (keep) => {
    if (!editing) return;
    const { element, initial, done } = editing;
    editing = null;
    element.removeAttribute('contenteditable');
    const text = element.innerText.replace(/\n$/, '');
    done(keep ? text : initial, keep && text !== initial);
  };
  const edit = (element, initial, done) => {
    finish(true);
    hideBar();
    element.textContent = initial;
    element.setAttribute('contenteditable', 'plaintext-only');
    element.spellcheck = false;
    editing = { element, initial, done };
    element.focus();
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    element.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        finish(true);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        finish(false);
      }
    });
    // Only while it is still the label being written: one drawn over since says nothing.
    element.addEventListener('blur', () => {
      if (editing && editing.element === element) finish(true);
    });
  };
  const editNode = (id, fresh) => {
    const node = ctx.node(id);
    const element = ctx.nodeEls.get(id);
    if (!node || !element) return;
    select([id]);
    edit(element.querySelector('.d-label'), node.label || '', (text, changed) => {
      if (changed) {
        if (!fresh) record();
        node.label = text.slice(0, LABEL_MAX);
      }
      ctx.draw();
      syncBar();
    });
  };
  const editEdge = (index) => {
    const edge = model.edges[index];
    const made = ctx.edges()[index];
    if (!edge || !made) return;
    select([], index);
    let element = made.label;
    if (!element) {
      element = html('div', 'd-edge-label', ctx.labelsLayer);
      element.style.left = made.middle[0] + 'px';
      element.style.top = made.middle[1] + 'px';
    }
    edit(element, edge.label || '', (text, changed) => {
      if (changed) {
        record();
        if (text.trim()) edge.label = text.slice(0, EDGE_LABEL_MAX);
        else delete edge.label;
      }
      ctx.draw();
      syncBar();
    });
  };
  const editGroup = (element) => {
    const group = model.groups.find((each) => each.id === element.dataset.group);
    if (!group) return;
    edit(element, group.label || '', (text, changed) => {
      if (changed) {
        record();
        group.label = text.slice(0, EDGE_LABEL_MAX);
      }
      ctx.draw();
    });
  };

  const freshId = () => {
    const taken = new Set(model.nodes.map((node) => node.id));
    let n = model.nodes.length + 1;
    while (taken.has('n' + n)) n++;
    return 'n' + n;
  };
  const add = (shape, at, from) => {
    record();
    const node = { id: freshId(), label: '', shape, x: Math.round(at[0]), y: Math.round(at[1]) };
    model.nodes.push(node);
    if (from) model.edges.push({ from, to: node.id });
    ctx.draw();
    editNode(node.id, true);
  };
  // In the middle of the view, a step aside from any node already standing there.
  const addInView = (shape) => {
    const at = view.middle();
    while (model.nodes.some((node) => Math.abs(node.x - at[0]) < 12 && Math.abs(node.y - at[1]) < 12)) {
      at[0] += 28;
      at[1] += 28;
    }
    add(shape, at);
  };
  const remove = () => {
    if (picked.edge !== null && model.edges[picked.edge]) {
      record();
      model.edges.splice(picked.edge, 1);
    } else if (picked.nodes.size) {
      record();
      model.nodes = model.nodes.filter((node) => !picked.nodes.has(node.id));
      model.edges = model.edges.filter((edge) => !picked.nodes.has(edge.from) && !picked.nodes.has(edge.to));
    } else return;
    picked.nodes = new Set();
    picked.edge = null;
    ctx.draw();
    syncBar();
  };
  const change = (apply) => {
    record();
    apply();
    ctx.draw();
    syncBar();
  };

  // The bar at the top: a node of each shape, then undo and redo.
  const tools = html('div', 'glass d-tools', view.overlay);
  tools.setAttribute('role', 'toolbar');
  tools.setAttribute('aria-label', 'Diagram');
  for (const shape of ctx.SHAPES) {
    tools.append(button('Add ' + SHAPE_NAME[shape].toLowerCase(), canvasIcon(ICON[shape]), () => addInView(shape)));
  }
  tools.append(rule());
  const undoButton = button('Undo', canvasIcon(ICON.undo), undo);
  const redoButton = button('Redo', canvasIcon(ICON.redo), redo);
  tools.append(undoButton, redoButton);
  const syncTools = () => {
    undoButton.disabled = !past.length;
    redoButton.disabled = !future.length;
  };
  syncTools();

  // The bar over what is picked.
  const bar = html('div', 'glass d-bar', view.overlay);
  bar.setAttribute('role', 'toolbar');
  bar.hidden = true;
  const hideBar = () => (bar.hidden = true);
  const placeBar = () => {
    if (bar.hidden) return;
    let box = null;
    if (picked.edge !== null) {
      const made = ctx.edges()[picked.edge];
      if (made && made.middle) box = [made.middle[0], made.middle[1], made.middle[0], made.middle[1]];
    } else {
      for (const id of picked.nodes) {
        const node = ctx.node(id);
        if (!node) continue;
        const [x, y, w, h] = ctx.boxOf(node);
        box = box ? [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x + w), Math.max(box[3], y + h)] : [x, y, x + w, y + h];
      }
    }
    if (!box) return hideBar();
    const top = view.toScreen(box[0], box[1]);
    const bottom = view.toScreen(box[2], box[3]);
    const width = bar.offsetWidth;
    const height = bar.offsetHeight;
    let y = top[1] - height - 14;
    if (y < 60) y = bottom[1] + 14;
    y = Math.max(60, Math.min(y, root.clientHeight - height - 8));
    const x = Math.max(8, Math.min((top[0] + bottom[0]) / 2 - width / 2, root.clientWidth - width - 8));
    bar.style.left = x + 'px';
    bar.style.top = y + 'px';
  };
  const syncBar = () => {
    bar.replaceChildren();
    const nodes = [...picked.nodes].map(ctx.node).filter(Boolean);
    const edge = picked.edge !== null ? model.edges[picked.edge] : null;
    if (editing || (!nodes.length && !edge)) return hideBar();
    if (edge) {
      bar.setAttribute('aria-label', 'Edge');
      const style = edge.style || 'solid';
      const arrow = edge.arrow || 'end';
      bar.append(
        button('Solid line', canvasIcon(ICON.solid), () => change(() => delete edge.style), style === 'solid'),
        button('Dashed line', canvasIcon(ICON.dashed), () => change(() => (edge.style = 'dashed')), style === 'dashed'),
        rule(),
        button('Arrow at the end', canvasIcon(ICON.end), () => change(() => delete edge.arrow), arrow === 'end'),
        button('Arrows at both ends', canvasIcon(ICON.both), () => change(() => (edge.arrow = 'both')), arrow === 'both'),
        button('No arrow', canvasIcon(ICON.none), () => change(() => (edge.arrow = 'none')), arrow === 'none'),
        rule(),
        button('Label', canvasIcon(ICON.label), () => editEdge(picked.edge)),
        button('Delete', canvasIcon(ICON.trash), remove),
      );
    } else {
      bar.setAttribute('aria-label', nodes.length > 1 ? 'Nodes' : 'Node');
      const same = (read) => nodes.every((node) => read(node) === read(nodes[0])) ? read(nodes[0]) : null;
      const shape = same(ctx.shapeOf);
      for (const each of ctx.SHAPES) {
        bar.append(button(SHAPE_NAME[each], canvasIcon(ICON[each]), () => change(() => {
          for (const node of nodes) node.shape = each;
        }), shape === each));
      }
      bar.append(rule());
      const color = same((node) => node.color || '');
      for (const each of [''].concat(ctx.COLORS)) {
        const swatch = '<span class="d-swatch c-' + (each || 'default') + '"></span>';
        const name = each ? each[0].toUpperCase() + each.slice(1) : 'Default colour';
        bar.append(button(name, swatch, () => change(() => {
          for (const node of nodes) {
            if (each) node.color = each;
            else delete node.color;
          }
        }), color === each));
      }
      bar.append(rule(), button('Delete', canvasIcon(ICON.trash), remove));
    }
    bar.hidden = false;
    placeBar();
  };
  view.watch(placeBar);

  // What a press does, when it lands on something of the diagram's.
  let gesture = null;
  const nodeAt = (event) => {
    const under = document.elementFromPoint(event.clientX, event.clientY);
    const element = under && under.closest('.d-node');
    return element ? element.dataset.id : null;
  };
  const begin = (event, made) => {
    event.preventDefault();
    gesture = Object.assign({ pointer: event.pointerId, far: false }, made);
    root.setPointerCapture(event.pointerId);
  };
  hooks.claim = (event) => {
    if (editing && editing.element.contains(event.target)) return true;
    finish(true);
    root.focus({ preventScroll: true });
    const target = event.target;
    const handle = target.closest('.d-handle');
    if (handle) {
      const from = handle.closest('.d-node').dataset.id;
      const preview = svg('path', { class: 'd-preview' }, ctx.lines);
      hideBar();
      begin(event, { kind: 'connect', from, preview, start: [event.clientX, event.clientY] });
      return true;
    }
    const element = target.closest('.d-node');
    if (element) {
      const id = element.dataset.id;
      if (event.shiftKey) {
        const next = new Set(picked.nodes);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        select(next);
      } else if (!picked.nodes.has(id)) select([id]);
      const moving = [...picked.nodes].map(ctx.node).filter(Boolean);
      begin(event, {
        kind: 'drag',
        only: id,
        shift: event.shiftKey,
        from: view.toWorld(event.clientX, event.clientY),
        start: moving.map((node) => [node, node.x, node.y]),
      });
      return true;
    }
    const line = target.closest('[data-edge]');
    if (line) {
      event.preventDefault();
      select([], Number(line.dataset.edge));
      return true;
    }
    if (event.shiftKey) {
      const box = html('div', 'd-marquee', view.overlay);
      begin(event, { kind: 'marquee', box, from: [event.clientX, event.clientY], base: new Set(picked.nodes) });
      return true;
    }
    return false;
  };
  hooks.tapped = () => {
    finish(true);
    root.focus({ preventScroll: true });
    select([]);
  };
  const stop = () => {
    if (!gesture) return;
    if (gesture.preview) gesture.preview.remove();
    if (gesture.box) gesture.box.remove();
    for (const element of ctx.nodeEls.values()) element.classList.remove('target');
    gesture = null;
  };
  hooks.cancel = stop;

  root.addEventListener('pointermove', (event) => {
    if (!gesture || event.pointerId !== gesture.pointer) return;
    if (gesture.kind === 'drag') {
      const at = view.toWorld(event.clientX, event.clientY);
      const dx = at[0] - gesture.from[0];
      const dy = at[1] - gesture.from[1];
      if (!gesture.far && Math.hypot(dx, dy) * view.scale() < 3) return;
      if (!gesture.far) {
        gesture.far = true;
        record();
        hideBar();
      }
      for (const [node, x, y] of gesture.start) {
        node.x = Math.round(x + dx);
        node.y = Math.round(y + dy);
      }
      ctx.refresh();
    } else if (gesture.kind === 'connect') {
      gesture.far = gesture.far || Math.hypot(event.clientX - gesture.start[0], event.clientY - gesture.start[1]) > 4;
      const from = ctx.node(gesture.from);
      const over = nodeAt(event);
      const target = over && over !== gesture.from ? ctx.node(over) : null;
      for (const [id, element] of ctx.nodeEls) element.classList.toggle('target', Boolean(target) && id === target.id);
      const point = view.toWorld(event.clientX, event.clientY);
      const end = target ? ctx.anchor(target, [from.x, from.y]) : [point[0], point[1], 0, 0];
      gesture.preview.setAttribute('d', ctx.curve(ctx.anchor(from, end), end).d);
    } else if (gesture.kind === 'marquee') {
      const box = root.getBoundingClientRect();
      const x1 = Math.min(gesture.from[0], event.clientX);
      const y1 = Math.min(gesture.from[1], event.clientY);
      const x2 = Math.max(gesture.from[0], event.clientX);
      const y2 = Math.max(gesture.from[1], event.clientY);
      gesture.box.style.cssText = 'left: ' + (x1 - box.left) + 'px; top: ' + (y1 - box.top) + 'px; width: ' + (x2 - x1) + 'px; height: ' + (y2 - y1) + 'px;';
      const a = view.toWorld(x1, y1);
      const b = view.toWorld(x2, y2);
      const hits = new Set(gesture.base);
      for (const node of model.nodes) {
        const [x, y, w, h] = ctx.boxOf(node);
        if (x < b[0] && x + w > a[0] && y < b[1] && y + h > a[1]) hits.add(node.id);
      }
      picked.nodes = hits;
      picked.edge = null;
      ctx.decorate();
    }
  });
  const release = (event) => {
    if (!gesture || event.pointerId !== gesture.pointer) return;
    const done = gesture;
    if (event.type === 'pointerup' && done.kind === 'drag' && !done.far && !done.shift && picked.nodes.size > 1) {
      select([done.only]);
    }
    if (event.type === 'pointerup' && done.kind === 'connect') {
      const over = nodeAt(event);
      const onBar = event.target && view.overlay.contains(document.elementFromPoint(event.clientX, event.clientY));
      if (over && over !== done.from) {
        stop();
        record();
        model.edges.push({ from: done.from, to: over });
        ctx.draw();
        // Picked, so its bar is at hand to label it.
        select([], model.edges.length - 1);
        return;
      }
      if (!over && done.far && !onBar) {
        stop();
        const source = ctx.node(done.from);
        add(source ? ctx.shapeOf(source) : 'rounded', view.toWorld(event.clientX, event.clientY), done.from);
        return;
      }
    }
    stop();
    syncBar();
  };
  root.addEventListener('pointerup', release);
  root.addEventListener('pointercancel', release);

  root.addEventListener('dblclick', (event) => {
    const target = event.target;
    if (view.overlay.contains(target) && target !== view.overlay) return;
    if (editing && editing.element.contains(target)) return;
    const element = target.closest('.d-node');
    if (element) return editNode(element.dataset.id);
    const line = target.closest('[data-edge]');
    if (line) return editEdge(Number(line.dataset.edge));
    const group = target.closest('.d-group-label');
    if (group) return editGroup(group);
    add('rounded', view.toWorld(event.clientX, event.clientY));
  });

  addEventListener('keydown', (event) => {
    if (typing(event)) return;
    const mod = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    if (mod && key === 'z') {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    } else if (mod && key === 'y') {
      event.preventDefault();
      redo();
    } else if (mod && key === 'a') {
      event.preventDefault();
      select(model.nodes.map((node) => node.id));
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      remove();
    } else if (event.key === 'Escape') {
      select([]);
    } else if (event.key === 'Enter' && picked.nodes.size === 1) {
      event.preventDefault();
      editNode([...picked.nodes][0]);
    } else if (event.key === 'Enter' && picked.edge !== null) {
      event.preventDefault();
      editEdge(picked.edge);
    } else if (event.key.startsWith('Arrow') && picked.nodes.size && !mod) {
      event.preventDefault();
      const step = event.shiftKey ? 10 : 1;
      const move = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
      record();
      for (const id of picked.nodes) {
        const node = ctx.node(id);
        node.x += move[0];
        node.y += move[1];
      }
      ctx.refresh();
      placeBar();
    }
  });
  // Pasted as words alone, into a label.
  addEventListener('paste', (event) => {
    if (!editing) return;
    event.preventDefault();
    document.execCommand('insertText', false, event.clipboardData.getData('text/plain'));
  });
};
`;
