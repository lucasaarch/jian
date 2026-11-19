import { SHEET_EDITING } from './sheet-editing.js';
import { SHEET_MODEL } from './sheet-model.js';
import { SHEET_STYLE } from './sheet-style.js';

/**
 * A spreadsheet in its frame, as script for the frame's page kept as text:
 * `const sheet = (source, root, editable) => { … }`, which draws the CSV in `source` into `root`
 * and answers `{ now, changed }` for the one who collects the edit (edit-frame.ts).
 *
 * - Reading the CSV and working a cell out is sheet-model.ts, written into this script.
 * - The source is CSV, one row a line. A cell that starts with `=` is a formula, worked out here
 *   with a reader of its own: the frame refuses `eval`, and a formula is the owner's or the
 *   agent's text, never code. It knows arithmetic, `&`, comparisons, references (`B2`, `A1:C3`)
 *   and a few functions; anything else reads `#NAME?`, a loop `#CYCLE!`.
 * - Read or edited, a cell or a range is picked with the pointer or the keys (arrows, Shift for
 *   a range, Cmd or Ctrl to the edge of what is filled) and copied as tab-separated text, the
 *   values for another program and the formulas for a sheet. The bar over the grid shows the
 *   cell picked as written, a formula included. A number reads at ten significant digits at
 *   most; what is saved is what was written.
 * - Editing is sheet-editing.ts. The grid has room around what is written, and what is saved is
 *   trimmed to what holds something.
 *
 * Focus lives in one text box over the picked cell, invisible until a cell is written: whatever
 * is typed lands there, so a key, a dead key or a word composed in another script all start
 * writing the cell, and the clipboard reaches it. The frame takes focus only when clicked: it
 * sits in the panel beside the conversation, whose box must keep it.
 *
 * No template literal inside: this file is one already.
 */
export const SHEET = String.raw`
const sheet = (source, root, editable) => {
${SHEET_MODEL}

  const style = document.createElement('style');
  style.textContent = ${JSON.stringify(SHEET_STYLE)};
  document.head.append(style);

  const make = (tag, className, attributes) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    for (const name in attributes || {}) node.setAttribute(name, attributes[name]);
    return node;
  };
  const bar = make('div', 'sheet-bar');
  const name = make('output', 'sheet-name');
  const fx = make('span', 'sheet-fx', { 'aria-hidden': 'true' });
  fx.textContent = 'fx';
  const field = make('textarea', 'sheet-field', { 'aria-label': 'Cell', rows: '1', spellcheck: 'false' });
  field.readOnly = !editable;
  bar.append(name, fx, field);
  const scroll = make('div', 'sheet-scroll');
  const range = make('div', 'sheet-range');
  const pointed = make('div', 'sheet-pointed');
  pointed.hidden = true;
  const active = make('div', 'sheet-active');
  const editor = make('textarea', 'sheet-editor', {
    'aria-label': 'Edit cell', rows: '1', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off',
  });
  editor.readOnly = !editable;
  const table = make('table', 'sheet-grid');
  // In this order: what lies on the grid is drawn under its headers, which come later.
  scroll.append(range, pointed, active, editor, table);
  root.replaceChildren(bar, scroll);

  const FONT = '13px system-ui, -apple-system, "Segoe UI", sans-serif';
  const ruler = document.createElement('canvas').getContext('2d');
  const widths = new Map();
  const measure = (text) => {
    if (!widths.has(text)) {
      if (widths.size > 5000) widths.clear();
      ruler.font = FONT;
      widths.set(text, ruler.measureText(text).width);
    }
    return widths.get(text);
  };
  const clamp = (n, low, high) => Math.max(low, Math.min(high, n));

  const original = csv(rows);
  // Rows and columns drawn. Editing, the grid only grows: what the owner took out or emptied
  // leaves its room, as in any spreadsheet.
  let size = [0, 0];
  // The cell picked and written to, and the far corner of the range picked from it.
  let anchor = [0, 0];
  let far = [0, 0];
  // The cell being written, when one is: { r, c, before, typed }. sheet-editing.ts sets it.
  let editing = null;

  const put = (target, r, c, value) => {
    if (value === '' && !(target[r] && c < target[r].length)) return;
    while (target.length <= r) target.push([]);
    while (target[r].length <= c) target[r].push('');
    target[r][c] = value;
  };
  // The sheet as it stands, with what is being written in it: the panel collects as the owner
  // pauses or leaves, and leaving in the middle of a cell must not lose it.
  const current = () => {
    if (!editing) return rows;
    const copy = rows.map((row) => row.slice());
    put(copy, editing.r, editing.c, editor.value);
    return copy;
  };

  const extent = () => {
    const used = tidy(rows);
    const width = Math.max(1, ...used.map((row) => row.length));
    return editable
      ? [Math.max(used.length + 5, 30), Math.max(width + 2, 8)]
      : [Math.max(used.length, 1), width];
  };
  const cellAt = (r, c) => table.rows[r + 1].cells[c + 1];
  const where = (cell) => [cell.parentElement.rowIndex - 1, cell.cellIndex - 1];
  const cellName = (r, c) => letters(c) + (r + 1);
  const bounds = () => [
    Math.min(anchor[0], far[0]), Math.min(anchor[1], far[1]),
    Math.max(anchor[0], far[0]), Math.max(anchor[1], far[1]),
  ];

  const build = () => {
    let html = '<colgroup><col>';
    for (let c = 0; c < size[1]; c++) html += '<col>';
    if (editable) html += '<col style="width:32px">';
    html += '</colgroup><thead><tr><th class="sheet-corner"></th>';
    for (let c = 0; c < size[1]; c++) html += '<th data-col="' + c + '">' + letters(c) + '</th>';
    if (editable) {
      html += '<th><button type="button" class="sheet-add" data-add="column" title="Add 3 columns"' +
        ' aria-label="Add 3 columns">+</button></th>';
    }
    html += '</tr></thead><tbody>';
    const gutter = editable ? '<td class="sheet-gutter"></td>' : '';
    for (let r = 0; r < size[0]; r++) {
      html += '<tr><th data-row="' + r + '">' + (r + 1) + '</th>';
      for (let c = 0; c < size[1]; c++) html += '<td data-at="' + r + ',' + c + '"></td>';
      html += gutter + '</tr>';
    }
    if (editable) {
      html += '<tr class="sheet-more"><th><button type="button" class="sheet-add" data-add="row"' +
        ' title="Add 10 rows" aria-label="Add 10 rows">+</button></th><td colspan="' + (size[1] + 1) + '"></td></tr>';
    }
    table.innerHTML = html + '</tbody>';
  };

  // A number as a sheet shows it by default: ten significant digits at most, and very large or
  // very small ones in scientific notation. Only how it reads; the cell keeps what was written.
  const figure = (n) => {
    if (!Number.isFinite(n)) return '#NUM!';
    const magnitude = Math.abs(n);
    if (magnitude !== 0 && (magnitude >= 1e15 || magnitude < 1e-6)) return n.toExponential(4).replace(/\.?0+e/, 'e');
    return String(Number(n.toPrecision(10)));
  };
  const look = (r, c) => {
    try {
      const value = valueAt(r, c);
      if (typeof value === 'number') return [figure(value), 'number'];
      if (typeof value === 'boolean') return [value ? 'TRUE' : 'FALSE', 'logical'];
      return [value, ''];
    } catch (error) {
      return [error.code || '#ERROR!', 'error'];
    }
  };

  // The range picked, the cell written to, the headers they lie in and the bar.
  const cover = (node, r1, c1, r2, c2) => {
    const first = cellAt(r1, c1);
    const last = cellAt(r2, c2);
    node.style.top = table.offsetTop + first.offsetTop - 1 + 'px';
    node.style.left = table.offsetLeft + first.offsetLeft - 1 + 'px';
    node.style.width = last.offsetLeft + last.offsetWidth - first.offsetLeft + 1 + 'px';
    node.style.height = last.offsetTop + last.offsetHeight - first.offsetTop + 1 + 'px';
  };
  const mark = () => {
    const [r1, c1, r2, c2] = bounds();
    range.hidden = r1 === r2 && c1 === c2;
    if (!range.hidden) cover(range, r1, c1, r2, c2);
    cover(active, anchor[0], anchor[1], anchor[0], anchor[1]);
    if (!editing) {
      cover(editor, anchor[0], anchor[1], anchor[0], anchor[1]);
      field.value = raw(anchor[0], anchor[1]);
    }
    for (let c = 0; c < size[1]; c++) table.rows[0].cells[c + 1].classList.toggle('on', c >= c1 && c <= c2);
    for (let r = 0; r < size[0]; r++) table.rows[r + 1].cells[0].classList.toggle('on', r >= r1 && r <= r2);
    name.textContent = cellName(anchor[0], anchor[1]) + (range.hidden ? '' : ':' + cellName(r2, c2));
  };

  const paint = () => {
    worked = new Map();
    const want = extent();
    const next = editable ? [Math.max(size[0], want[0]), Math.max(size[1], want[1])] : want;
    if (next[0] !== size[0] || next[1] !== size[1]) {
      size = next;
      build();
    }
    anchor = [Math.min(anchor[0], size[0] - 1), Math.min(anchor[1], size[1] - 1)];
    far = [Math.min(far[0], size[0] - 1), Math.min(far[1], size[1] - 1)];
    const longest = new Array(size[1]).fill(0);
    for (let r = 0; r < size[0]; r++) {
      const line = table.rows[r + 1];
      for (let c = 0; c < size[1]; c++) {
        const cell = line.cells[c + 1];
        const [text, kind] = look(r, c);
        if (cell.textContent !== text) cell.textContent = text;
        if (cell.className !== kind) cell.className = kind;
        // Numbers are drawn with figures of one width, each as wide as a 0.
        const shape = kind === 'number' ? text.replace(/\d/g, '0') : text.split('\n')[0];
        if (text !== '') longest[c] = Math.max(longest[c], measure(shape));
      }
    }
    // Each column as wide as what it holds, within reason; the row numbers as wide as the last.
    const columns = table.querySelectorAll('col');
    const side = Math.max(40, Math.ceil(measure(String(size[0]))) + 20);
    let total = side + (editable ? 32 : 0);
    columns[0].style.width = side + 'px';
    for (let c = 0; c < size[1]; c++) {
      const width = clamp(Math.ceil(longest[c]) + 20, 80, 360);
      columns[c + 1].style.width = width + 'px';
      total += width;
    }
    table.style.width = total + 'px';
    mark();
  };

  // Brings a cell into view from under the headers that stick over it.
  const reveal = (r, c) => {
    const cell = cellAt(r, c);
    const top = table.offsetTop + cell.offsetTop;
    const left = table.offsetLeft + cell.offsetLeft;
    const head = table.rows[0].offsetHeight;
    const side = table.rows[0].cells[0].offsetWidth;
    if (top - head < scroll.scrollTop) scroll.scrollTop = top - head;
    else if (top + cell.offsetHeight > scroll.scrollTop + scroll.clientHeight) {
      scroll.scrollTop = top + cell.offsetHeight - scroll.clientHeight;
    }
    if (left - side < scroll.scrollLeft) scroll.scrollLeft = left - side;
    else if (left + cell.offsetWidth > scroll.scrollLeft + scroll.clientWidth) {
      scroll.scrollLeft = left + cell.offsetWidth - scroll.clientWidth;
    }
  };
  const grow = (down, across) => {
    size = [size[0] + down, size[1] + across];
    build();
    paint();
  };
  // Where Enter goes after a run of Tabs, as in Excel: back to the column the run began in.
  let home = null;
  const select = (r, c, extend) => {
    home = null;
    if (editable && (r >= size[0] || c >= size[1])) {
      grow(Math.max(0, r - size[0] + 1), Math.max(0, c - size[1] + 1));
    }
    far = [clamp(r, 0, size[0] - 1), clamp(c, 0, size[1] - 1)];
    if (!extend) anchor = far.slice();
    mark();
    reveal(far[0], far[1]);
  };
  const pickLines = (axis, from, to) => {
    const last = axis === 'r' ? size[1] - 1 : size[0] - 1;
    anchor = axis === 'r' ? [from, 0] : [0, from];
    far = axis === 'r' ? [to, last] : [last, to];
    home = null;
    mark();
  };
  // A step of Enter or Tab, Shift going back.
  const step = (key, back) => {
    const d = back ? -1 : 1;
    if (key === 'Tab') {
      const start = home === null ? anchor[1] : home;
      select(anchor[0], anchor[1] + d);
      home = start;
    } else select(anchor[0] + d, home === null ? anchor[1] : home);
  };
  // Cmd or Ctrl with an arrow, as in Excel: to the end of the filled cells it starts in, or to
  // the next filled one, or to the edge.
  const edge = ([r, c], [dr, dc]) => {
    const inside = (r, c) => r >= 0 && c >= 0 && r < size[0] && c < size[1];
    const full = (r, c) => raw(r, c) !== '';
    if (full(r, c) && inside(r + dr, c + dc) && full(r + dr, c + dc)) {
      while (inside(r + dr, c + dc) && full(r + dr, c + dc)) { r += dr; c += dc; }
      return [r, c];
    }
    do { r += dr; c += dc; } while (inside(r, c) && !full(r, c));
    return inside(r, c) ? [r, c] : [clamp(r, 0, size[0] - 1), clamp(c, 0, size[1] - 1)];
  };

  // A range as text with tabs, as spreadsheets put one on the clipboard: what it shows for
  // anything else, and for a sheet of ours what is written in it, so its formulas come along.
  const CLIP = 'application/x-jian-sheet';
  const cut = (text) => (/[\t\n\r"]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text);
  const clip = (event) => {
    const [r1, c1, r2, c2] = bounds();
    const shownRows = [];
    const written = [];
    for (let r = r1; r <= r2; r++) {
      const line = [];
      const raws = [];
      for (let c = c1; c <= c2; c++) {
        line.push(cut(look(r, c)[0]));
        raws.push(raw(r, c));
      }
      shownRows.push(line.join('\t'));
      written.push(raws);
    }
    event.preventDefault();
    event.clipboardData.setData('text/plain', shownRows.join('\n'));
    event.clipboardData.setData(CLIP, JSON.stringify({ at: [r1, c1], rows: written }));
  };

  if (editable) {
${SHEET_EDITING}
  }

  const ARROWS = { ArrowDown: [1, 0], ArrowUp: [-1, 0], ArrowRight: [0, 1], ArrowLeft: [0, -1] };
  editor.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || editing || event.isComposing) return;
    const mod = event.metaKey || event.ctrlKey;
    const arrow = ARROWS[event.key];
    const page = Math.max(1, Math.floor(scroll.clientHeight / 24) - 1);
    if (arrow) {
      const from = event.shiftKey ? far : anchor;
      const to = mod ? edge(from, arrow) : [from[0] + arrow[0], from[1] + arrow[1]];
      select(to[0], to[1], event.shiftKey);
    } else if (event.key === 'Tab' || event.key === 'Enter') step(event.key, event.shiftKey);
    else if (event.key === 'Home') select(mod ? 0 : anchor[0], 0);
    else if (event.key === 'End' && mod) {
      const used = tidy(rows);
      select(Math.max(0, used.length - 1), Math.max(0, ...used.map((row) => row.length - 1)));
    } else if (event.key === 'PageDown') select(anchor[0] + page, anchor[1], event.shiftKey);
    else if (event.key === 'PageUp') select(anchor[0] - page, anchor[1], event.shiftKey);
    else if (mod && event.key.toLowerCase() === 'a') {
      anchor = [0, 0];
      far = [size[0] - 1, size[1] - 1];
      mark();
    } else return;
    event.preventDefault();
  });
  editor.addEventListener('copy', (event) => {
    if (!editing) clip(event);
  });

  // Dragging picks a range of cells, or of whole rows or columns from their headers.
  let dragging = null;
  scroll.addEventListener('mousedown', (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    const cell = event.target.closest('td[data-at]');
    const head = event.target.closest('th[data-row], th[data-col], th.sheet-corner');
    if (!cell && !head) return;
    event.preventDefault();
    editor.focus({ preventScroll: true });
    if (cell) {
      const [r, c] = where(cell);
      select(r, c, event.shiftKey);
      dragging = 'cell';
    } else if (head.classList.contains('sheet-corner')) {
      anchor = [0, 0];
      far = [size[0] - 1, size[1] - 1];
      mark();
    } else {
      const axis = head.dataset.row === undefined ? 'c' : 'r';
      const at = Number(axis === 'r' ? head.dataset.row : head.dataset.col);
      const from = event.shiftKey ? anchor[axis === 'r' ? 0 : 1] : at;
      pickLines(axis, from, at);
      dragging = axis;
    }
  });
  scroll.addEventListener('mouseover', (event) => {
    if (!dragging) return;
    if (dragging === 'cell') {
      const cell = event.target.closest('td[data-at]');
      if (!cell) return;
      far = where(cell);
      mark();
      return;
    }
    const head = event.target.closest(dragging === 'r' ? 'th[data-row]' : 'th[data-col]');
    if (head) pickLines(dragging, anchor[dragging === 'r' ? 0 : 1], Number(head.dataset.row ?? head.dataset.col));
  });
  addEventListener('mouseup', () => {
    dragging = null;
  });

  paint();
  return { now: () => csv(current()), changed: () => csv(current()) !== original };
};
`;
