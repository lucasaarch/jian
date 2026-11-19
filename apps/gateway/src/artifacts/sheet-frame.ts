import { SHEET_MODEL } from './sheet-model.js';

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
 * - The bar over the grid shows the cell picked as it is written, a formula included. Editing,
 *   it is where the cell is written: typing on a picked cell starts there, Enter goes down, Tab
 *   right, Escape puts back what was there. The grid has room around what is written, and what
 *   is saved is trimmed to what holds something.
 *
 * No template literal inside: this file is one already.
 */
export const SHEET = `
const sheet = (source, root, editable) => {
${SHEET_MODEL}

  const style = document.createElement('style');
  style.textContent =
    '#root { display: flex; flex-direction: column; height: 100vh; }' +
    '.sheet-bar { display: flex; gap: 8px; align-items: center; padding: 6px 8px;' +
    '  border-bottom: 1px solid color-mix(in srgb, CanvasText 15%, transparent); }' +
    '.sheet-bar output { min-width: 3.5em; font: 12px ui-monospace, Menlo, monospace;' +
    '  color: color-mix(in srgb, CanvasText 60%, transparent); }' +
    '.sheet-bar input { flex: 1; min-width: 0; padding: 4px 6px; border-radius: 6px; color: inherit;' +
    '  font: 13px ui-monospace, Menlo, monospace; background: transparent;' +
    '  border: 1px solid color-mix(in srgb, CanvasText 18%, transparent); }' +
    '.sheet-scroll { flex: 1; overflow: auto; }' +
    '.sheet-grid { border-collapse: separate; border-spacing: 0; font: 13px/1.4 system-ui, sans-serif; }' +
    '.sheet-grid th, .sheet-grid td { min-width: 88px; max-width: 320px; height: 22px; padding: 2px 8px;' +
    '  border: 0 solid color-mix(in srgb, CanvasText 12%, transparent); border-width: 0 1px 1px 0;' +
    '  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }' +
    '.sheet-grid th { position: sticky; z-index: 1; font-weight: 500; text-align: center;' +
    '  color: color-mix(in srgb, CanvasText 55%, transparent); background: Canvas; }' +
    '.sheet-grid thead th { top: 0; }' +
    '.sheet-grid tbody th { left: 0; min-width: 36px; }' +
    '.sheet-grid thead th:first-child { left: 0; z-index: 2; }' +
    '.sheet-grid td.number { text-align: right; font-variant-numeric: tabular-nums; }' +
    '.sheet-grid td.error { color: #d92d20; }' +
    '.sheet-grid td.picked { outline: 2px solid #4c8dff; outline-offset: -2px; }';
  document.head.append(style);

  const bar = document.createElement('div');
  bar.className = 'sheet-bar';
  const name = document.createElement('output');
  const field = document.createElement('input');
  field.setAttribute('aria-label', 'Cell');
  field.spellcheck = false;
  field.readOnly = !editable;
  bar.append(name, field);
  const scroll = document.createElement('div');
  scroll.className = 'sheet-scroll';
  const table = document.createElement('table');
  table.className = 'sheet-grid';
  scroll.append(table);
  root.replaceChildren(bar, scroll);

  const original = csv(rows);
  let picked = [0, 0];
  let before = '';
  let size = [0, 0];
  const extent = () => {
    const used = tidy(rows);
    const width = Math.max(1, ...used.map((row) => row.length));
    return editable
      ? [Math.max(used.length + 5, 30), Math.max(width + 2, 8)]
      : [Math.max(used.length, 1), width];
  };
  const build = () => {
    size = extent();
    let html = '<thead><tr><th></th>';
    for (let c = 0; c < size[1]; c++) html += '<th>' + letters(c) + '</th>';
    html += '</tr></thead><tbody>';
    for (let r = 0; r < size[0]; r++) {
      html += '<tr><th>' + (r + 1) + '</th>';
      for (let c = 0; c < size[1]; c++) html += '<td data-at="' + r + ',' + c + '"></td>';
      html += '</tr>';
    }
    table.innerHTML = html + '</tbody>';
  };
  const paint = () => {
    worked = new Map();
    const [height, width] = extent();
    if (height > size[0] || width > size[1] || (!editable && (height !== size[0] || width !== size[1]))) build();
    for (const cell of table.querySelectorAll('td')) {
      const [r, c] = cell.dataset.at.split(',').map(Number);
      const [value, kind] = shown(r, c);
      cell.textContent = value;
      cell.className = kind + (r === picked[0] && c === picked[1] ? ' picked' : '');
    }
    name.textContent = letters(picked[1]) + (picked[0] + 1);
    if (document.activeElement !== field) field.value = raw(picked[0], picked[1]);
  };
  const write = (value) => {
    const [r, c] = picked;
    while (rows.length <= r) rows.push([]);
    while (rows[r].length <= c) rows[r].push('');
    rows[r][c] = value;
    paint();
  };
  const pick = (r, c) => {
    picked = [Math.max(0, r), Math.max(0, c)];
    before = raw(picked[0], picked[1]);
    field.value = before;
    paint();
    const cell = table.querySelector('td[data-at="' + picked[0] + ',' + picked[1] + '"]');
    if (cell) cell.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };

  table.addEventListener('mousedown', (event) => {
    const cell = event.target.closest('td');
    if (!cell) return;
    event.preventDefault();
    const [r, c] = cell.dataset.at.split(',').map(Number);
    pick(r, c);
    if (editable) table.focus();
  });
  if (editable) {
    table.tabIndex = 0;
    table.addEventListener('dblclick', () => field.focus());
    field.addEventListener('input', () => write(field.value));
    field.addEventListener('keydown', (event) => {
      const moves = { Enter: [1, 0], Tab: [0, 1] };
      if (event.key === 'Escape') {
        field.value = before;
        write(before);
        table.focus();
      } else if (moves[event.key]) {
        event.preventDefault();
        const [dr, dc] = moves[event.key];
        const back = event.shiftKey ? -1 : 1;
        pick(picked[0] + dr * back, picked[1] + dc * back);
        table.focus();
      }
    });
    table.addEventListener('keydown', (event) => {
      const moves = {
        ArrowDown: [1, 0], ArrowUp: [-1, 0], ArrowRight: [0, 1], ArrowLeft: [0, -1],
        Enter: [1, 0], Tab: [0, 1],
      };
      if (moves[event.key]) {
        event.preventDefault();
        const [dr, dc] = moves[event.key];
        const back = event.shiftKey && (event.key === 'Enter' || event.key === 'Tab') ? -1 : 1;
        pick(picked[0] + dr * back, picked[1] + dc * back);
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        write('');
        field.value = '';
      } else if (event.key === 'F2') {
        field.focus();
      } else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        field.focus();
        field.value = event.key;
        write(event.key);
      }
    });
  }
  build();
  pick(0, 0);

  return { now: () => csv(rows), changed: () => csv(rows) !== original };
};
`;
