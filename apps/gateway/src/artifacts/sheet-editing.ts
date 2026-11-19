/**
 * How the owner edits a spreadsheet in its frame, as script written into the body of `sheet`
 * (sheet-frame.ts) when it is editable, with everything of that body in reach.
 *
 * - A cell is written in place, as in Excel: a double click, Enter or F2 opens it with what is
 *   written there, a formula included, and typing on a picked cell writes over it. Enter keeps
 *   it and goes down, Tab right, Shift back; Escape puts back what was there; a click elsewhere
 *   keeps it. Alt+Enter breaks the line. Begun by typing, the arrows keep the cell and move, as
 *   in Excel; opened, they move through the text. The bar writes the same cell.
 * - Writing a formula, a click on a cell where a reference can go puts its name in, and a drag
 *   a range; a second click before typing on replaces it.
 * - Rows and columns are put in and taken out from the menu of a cell or a header, the
 *   formulas following them (sheet-model.ts: `reshape`). The `+` at the end of the grid makes
 *   room; a row or column holds nothing until something is written in it.
 * - Delete clears what is picked, Cut and Paste work on ranges (a formula pasted from a sheet
 *   moves its references as far as it moved, and one value fills the whole range picked), and
 *   Cmd or Ctrl+Z undoes each of these and a cell written, Shift or Y redoing.
 *
 * No template literal inside: sheet-frame.ts holds this in one.
 */
export const SHEET_EDITING = String.raw`
  // One step of Undo is one thing the owner did. Each keeps the whole sheet as it was, which
  // for one written by hand is little.
  const past = [];
  const future = [];
  const snapshot = () => ({ rows: rows.map((row) => row.slice()), anchor: anchor.slice(), far: far.slice() });
  const change = (work) => {
    past.push(snapshot());
    if (past.length > 200) past.shift();
    future.length = 0;
    work();
    paint();
  };
  const travel = (from, to) => {
    if (!from.length) return;
    to.push(snapshot());
    const state = from.pop();
    rows = state.rows;
    anchor = state.anchor;
    far = state.far;
    paint();
    reveal(anchor[0], anchor[1]);
  };
  const clear = () => {
    const [r1, c1, r2, c2] = bounds();
    let filled = false;
    for (let r = r1; r <= r2 && !filled; r++) {
      for (let c = c1; c <= c2 && !filled; c++) filled = raw(r, c) !== '';
    }
    if (!filled) return;
    change(() => {
      for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) put(rows, r, c, '');
    });
  };

  // The editor grows with what is written: wider up to the edge of the view, then taller.
  const fit = () => {
    const cell = cellAt(editing.r, editing.c);
    const left = table.offsetLeft + cell.offsetLeft - 1;
    const least = cell.offsetWidth + 1;
    const room = Math.max(least, scroll.scrollLeft + scroll.clientWidth - left - 2);
    const wide = Math.max(...editor.value.split('\n').map(measure)) + 22;
    editor.style.top = table.offsetTop + cell.offsetTop - 1 + 'px';
    editor.style.left = left + 'px';
    editor.style.width = clamp(wide, least, room) + 'px';
    editor.style.height = '0px';
    editor.style.height = Math.max(cell.offsetHeight + 1, editor.scrollHeight + 4) + 'px';
  };
  // A reference being put into a formula with the pointer: where it lies in the text, and the
  // cell the drag began on.
  let pointing = null;
  const begin = (text, typed, into = editor) => {
    if (editing) return;
    closeMenu();
    far = anchor.slice();
    editing = { r: anchor[0], c: anchor[1], before: raw(anchor[0], anchor[1]), typed };
    pointing = null;
    // null: what was typed is already in the editor, a composition perhaps still under way.
    if (text !== null) editor.value = text;
    field.value = editor.value;
    scroll.classList.add('writing');
    mark();
    fit();
    if (document.activeElement !== into) into.focus({ preventScroll: true });
    if (text !== null && into === editor) editor.setSelectionRange(text.length, text.length);
  };
  const close = () => {
    editing = null;
    pointing = null;
    pointed.hidden = true;
    editor.value = '';
    scroll.classList.remove('writing');
    if (document.activeElement === field) editor.focus({ preventScroll: true });
  };
  const commit = () => {
    if (!editing) return;
    const { r, c, before } = editing;
    const value = editor.value;
    close();
    if (value !== before) change(() => put(rows, r, c, value));
    else mark();
  };
  const cancel = () => {
    if (!editing) return;
    close();
    mark();
  };

  const typist = () => (document.activeElement === field ? field : editor);
  const pointable = () => {
    const box = typist();
    if (!box.value.startsWith('=')) return false;
    const at = box.selectionStart;
    if (pointing && pointing.box === box && at === pointing.end) return true;
    return at === box.selectionEnd && /[=(,+\-*\/^&<>:]\s*$/.test(box.value.slice(0, at));
  };
  const point = (from, to) => {
    const box = typist();
    const r1 = Math.min(from[0], to[0]);
    const c1 = Math.min(from[1], to[1]);
    const r2 = Math.max(from[0], to[0]);
    const c2 = Math.max(from[1], to[1]);
    const ref = cellName(r1, c1) + (r1 === r2 && c1 === c2 ? '' : ':' + cellName(r2, c2));
    let start = box.selectionStart;
    if (pointing && pointing.box === box && start === pointing.end) start = pointing.start;
    box.setRangeText(ref, start, box.selectionEnd, 'end');
    pointing = { box, start, end: start + ref.length, from, dragging: true };
    pointed.hidden = false;
    cover(pointed, r1, c1, r2, c2);
    (box === editor ? field : editor).value = box.value;
    fit();
  };

  const menu = make('div', 'sheet-menu', { role: 'menu' });
  menu.hidden = true;
  document.body.append(menu);
  let items = [];
  let lit = -1;
  const light = (i) => {
    lit = i;
    items.forEach((item, at) => item.classList.toggle('lit', at === i));
  };
  const closeMenu = () => {
    menu.hidden = true;
    light(-1);
  };
  const openMenu = (x, y, list) => {
    menu.replaceChildren();
    items = [];
    for (const entry of list) {
      if (!entry) {
        menu.append(make('hr'));
        continue;
      }
      const [label, run, tone, hint] = entry;
      const item = make('button', tone || '', { type: 'button', role: 'menuitem' });
      const text = make('span');
      text.textContent = label;
      item.append(text);
      if (hint) {
        const key = make('kbd');
        key.textContent = hint;
        item.append(key);
      }
      item.addEventListener('click', () => {
        closeMenu();
        run();
        editor.focus({ preventScroll: true });
      });
      item.addEventListener('mouseenter', () => light(items.indexOf(item)));
      item.addEventListener('mouseleave', () => light(-1));
      items.push(item);
      menu.append(item);
    }
    menu.hidden = false;
    menu.style.left = Math.max(4, Math.min(x, innerWidth - menu.offsetWidth - 4)) + 'px';
    menu.style.top = Math.max(4, Math.min(y, innerHeight - menu.offsetHeight - 4)) + 'px';
  };
  // Pressing an entry must not take the focus from the grid it acts on.
  menu.addEventListener('mousedown', (event) => event.preventDefault());
  scroll.addEventListener('scroll', closeMenu);
  addEventListener('blur', closeMenu);
  addEventListener('resize', closeMenu);

  const lines = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');
  const reshaped = (axis, at, count) => change(() => reshape(axis, at, count));
  const menuFor = (kind) => {
    const [r1, c1, r2, c2] = bounds();
    const down = r2 - r1 + 1;
    const across = c2 - c1 + 1;
    const rowItems = [
      ['Insert ' + lines(down, 'row') + ' above', () => reshaped('r', r1, down)],
      ['Insert ' + lines(down, 'row') + ' below', () => reshaped('r', r2 + 1, down)],
    ];
    const columnItems = [
      ['Insert ' + lines(across, 'column') + ' left', () => reshaped('c', c1, across)],
      ['Insert ' + lines(across, 'column') + ' right', () => reshaped('c', c2 + 1, across)],
    ];
    const dropRows = [
      'Delete ' + (down === 1 ? 'row ' + (r1 + 1) : 'rows ' + (r1 + 1) + '–' + (r2 + 1)),
      () => reshaped('r', r1, -down),
      'danger',
    ];
    const dropColumns = [
      'Delete ' + (across === 1 ? 'column ' + letters(c1) : 'columns ' + letters(c1) + '–' + letters(c2)),
      () => reshaped('c', c1, -across),
      'danger',
    ];
    const wipe = ['Clear', clear, '', 'Delete'];
    if (kind === 'r') return [...rowItems, null, dropRows, null, wipe];
    if (kind === 'c') return [...columnItems, null, dropColumns, null, wipe];
    return [...rowItems, ...columnItems, null, dropRows, dropColumns, null, wipe];
  };
  scroll.addEventListener('contextmenu', (event) => {
    const cell = event.target.closest('td[data-at]');
    const head = event.target.closest('th[data-row], th[data-col]');
    if (!cell && !head) return;
    event.preventDefault();
    commit();
    editor.focus({ preventScroll: true });
    const [r1, c1, r2, c2] = bounds();
    let kind = 'cell';
    if (cell) {
      const [r, c] = where(cell);
      if (r < r1 || r > r2 || c < c1 || c > c2) select(r, c);
    } else {
      kind = head.dataset.row === undefined ? 'c' : 'r';
      const at = Number(kind === 'r' ? head.dataset.row : head.dataset.col);
      const whole = kind === 'r' ? c1 === 0 && c2 === size[1] - 1 : r1 === 0 && r2 === size[0] - 1;
      const [low, high] = kind === 'r' ? [r1, r2] : [c1, c2];
      if (!whole || at < low || at > high) pickLines(kind, at, at);
    }
    openMenu(event.clientX, event.clientY, menuFor(kind));
  });

  // A press anywhere but in the cell being written keeps it, unless it points at a cell for
  // the formula being written. Taken first, before the grid picks what was pressed.
  document.addEventListener('mousedown', (event) => {
    if (!menu.hidden && !menu.contains(event.target)) closeMenu();
    if (!editing || event.button !== 0 || event.target === editor || event.target === field) return;
    const cell = event.target.closest && event.target.closest('td[data-at]');
    if (cell && pointable()) {
      event.preventDefault();
      const at = where(cell);
      point(at, at);
      return;
    }
    commit();
  }, true);
  scroll.addEventListener('mouseover', (event) => {
    if (!pointing || !pointing.dragging) return;
    const cell = event.target.closest('td[data-at]');
    if (cell) point(pointing.from, where(cell));
  });
  addEventListener('mouseup', () => {
    if (pointing) pointing.dragging = false;
  });
  scroll.addEventListener('dblclick', (event) => {
    if (!editing && event.target.closest('td[data-at]')) begin(raw(anchor[0], anchor[1]), false);
  });
  table.addEventListener('mousedown', (event) => {
    if (event.target.closest('[data-add]')) event.preventDefault();
  });
  table.addEventListener('click', (event) => {
    const add = event.target.closest('[data-add]');
    if (!add) return;
    if (add.dataset.add === 'row') grow(10, 0);
    else grow(0, 3);
    editor.focus({ preventScroll: true });
  });

  editor.addEventListener('compositionstart', () => {
    if (!editing) begin(null, true);
  });
  editor.addEventListener('input', () => {
    if (!editing) begin(null, true);
    pointing = null;
    pointed.hidden = true;
    field.value = editor.value;
    fit();
  });
  field.addEventListener('focus', () => {
    if (!editing) begin(raw(anchor[0], anchor[1]), false, field);
  });
  field.addEventListener('input', () => {
    pointing = null;
    pointed.hidden = true;
    editor.value = field.value;
    if (editing) fit();
  });

  const STEPS = { ArrowDown: [1, 0], ArrowUp: [-1, 0], ArrowRight: [0, 1], ArrowLeft: [0, -1] };
  const keys = (event, box) => {
    if (event.isComposing || event.keyCode === 229) return;
    const key = event.key;
    const mod = event.metaKey || event.ctrlKey;
    if (!editing) {
      if (box !== editor) return;
      if (!menu.hidden) {
        event.preventDefault();
        if (key === 'Escape') closeMenu();
        else if (key === 'ArrowDown') light((lit + 1) % items.length);
        else if (key === 'ArrowUp') light((lit + items.length - 1) % items.length);
        else if (key === 'Enter' && items[lit]) items[lit].click();
        return;
      }
      if (mod && !event.altKey && key.toLowerCase() === 'z') {
        if (event.shiftKey) travel(future, past);
        else travel(past, future);
      } else if (mod && key.toLowerCase() === 'y') travel(future, past);
      else if ((key === 'Enter' && !event.shiftKey && !mod && !event.altKey) || key === 'F2') {
        begin(raw(anchor[0], anchor[1]), false);
      } else if (key === 'Delete' || key === 'Backspace') clear();
      else return;
      event.preventDefault();
      return;
    }
    if (key === 'Enter' && event.altKey) {
      event.preventDefault();
      document.execCommand('insertText', false, '\n');
    } else if (key === 'Enter' || key === 'Tab') {
      event.preventDefault();
      commit();
      step(key, event.shiftKey);
    } else if (key === 'Escape') {
      event.preventDefault();
      cancel();
    } else if (STEPS[key] && box === editor && editing.typed && !editor.value.startsWith('=')) {
      event.preventDefault();
      commit();
      select(anchor[0] + STEPS[key][0], anchor[1] + STEPS[key][1]);
    }
  };
  editor.addEventListener('keydown', (event) => keys(event, editor));
  field.addEventListener('keydown', (event) => keys(event, field));

  editor.addEventListener('cut', (event) => {
    if (editing) return;
    clip(event);
    clear();
  });
  editor.addEventListener('paste', (event) => {
    if (editing) return;
    event.preventDefault();
    let block = null;
    let from = null;
    try {
      const ours = JSON.parse(event.clipboardData.getData(CLIP) || 'null');
      if (ours && Array.isArray(ours.rows) && Array.isArray(ours.at)) {
        block = ours.rows.map((row) => row.map(String));
        from = ours.at;
      }
    } catch {
      block = null;
    }
    if (!block) block = parse(event.clipboardData.getData('text/plain'), '\t');
    if (!block.length) return;
    const [r1, c1, r2, c2] = bounds();
    // One value fills the whole range picked, as in a spreadsheet.
    const one = block.length === 1 && block[0].length === 1;
    const down = one ? r2 - r1 + 1 : block.length;
    const across = one ? c2 - c1 + 1 : Math.max(...block.map((row) => row.length));
    change(() => {
      for (let i = 0; i < down; i++) {
        for (let j = 0; j < across; j++) {
          let value = (one ? block[0][0] : block[i][j]) || '';
          if (from && value.startsWith('=')) {
            const source = one ? from : [from[0] + i, from[1] + j];
            value = '=' + moved(value.slice(1), r1 + i - source[0], c1 + j - source[1]);
          }
          put(rows, r1 + i, c1 + j, value);
        }
      }
      anchor = [r1, c1];
      far = [r1 + down - 1, c1 + across - 1];
    });
  });
`;
