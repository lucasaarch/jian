/**
 * A spreadsheet in its frame, as script for the frame's page kept as text:
 * `const sheet = (source, root, editable) => { … }`, which draws the CSV in `source` into `root`
 * and answers `{ now, changed }` for the one who collects the edit (edit-frame.ts).
 *
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
export const SHEET = String.raw`
const sheet = (source, root, editable) => {
  const parse = (text) => {
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c !== '"') cell += c;
        else if (text[i + 1] === '"') { cell += '"'; i++; }
        else quoted = false;
      } else if (c === '"' && cell === '') quoted = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += c;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows;
  };
  // What holds something, and nothing after it.
  const tidy = (rows) => {
    const kept = rows.map((row) => {
      let end = row.length;
      while (end > 0 && row[end - 1] === '') end--;
      return row.slice(0, end);
    });
    while (kept.length && !kept[kept.length - 1].length) kept.pop();
    return kept;
  };
  const quote = (cell) =>
    /[",\n\r]|^\s|\s$/.test(cell) ? '"' + cell.replaceAll('"', '""') + '"' : cell;
  const csv = (rows) => tidy(rows).map((row) => row.map(quote).join(',')).join('\n') + '\n';

  const letters = (n) => {
    let name = '';
    for (n += 1; n > 0; n = Math.floor((n - 1) / 26)) {
      name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
    }
    return name;
  };
  const columnOf = (name) => [...name].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
  const at = (ref) => {
    const found = /^([A-Z]+)(\d+)$/.exec(ref);
    return [Number(found[2]) - 1, columnOf(found[1])];
  };

  const fail = (code) => { const error = new Error(code); error.code = code; throw error; };
  const TOKEN = /\s*(?:(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|("(?:[^"]|"")*")|(\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?)|([A-Za-z_][A-Za-z0-9_.]*)|(<>|<=|>=|[-+*\/^&=<>(),%]))/y;
  const tokens = (text) => {
    const found = [];
    for (let from = 0; from < text.length;) {
      TOKEN.lastIndex = from;
      const m = TOKEN.exec(text);
      if (!m) {
        if (/^\s*$/.test(text.slice(from))) break;
        fail('#ERROR!');
      }
      from = TOKEN.lastIndex;
      if (m[1]) found.push({ n: Number(m[1]) });
      else if (m[2]) found.push({ s: m[2].slice(1, -1).replaceAll('""', '"') });
      else if (m[3]) found.push({ ref: m[3].replaceAll('$', '').toUpperCase() });
      else if (m[4]) found.push({ name: m[4].toUpperCase() });
      else found.push({ op: m[5] });
    }
    return found;
  };

  let rows = parse(source);
  const raw = (r, c) => (rows[r] && rows[r][c]) || '';
  const literal = (text) => {
    const trimmed = text.trim();
    return trimmed !== '' && /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(trimmed)
      ? Number(trimmed)
      : text;
  };
  const num = (value) => {
    if (Array.isArray(value)) fail('#VALUE!');
    if (typeof value === 'number') return value;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (value === '') return 0;
    const n = literal(value);
    return typeof n === 'number' ? n : fail('#VALUE!');
  };
  const text = (value) =>
    Array.isArray(value) ? fail('#VALUE!') : typeof value === 'boolean' ? (value ? 'TRUE' : 'FALSE') : String(value);
  const numbers = (args) =>
    args.flatMap((arg) => (Array.isArray(arg) ? arg.filter((v) => typeof v === 'number') : [num(arg)]));
  const FUNCTIONS = {
    SUM: (args) => numbers(args).reduce((a, b) => a + b, 0),
    AVERAGE: (args) => {
      const list = numbers(args);
      return list.length ? list.reduce((a, b) => a + b, 0) / list.length : fail('#DIV/0!');
    },
    MIN: (args) => { const list = numbers(args); return list.length ? Math.min(...list) : 0; },
    MAX: (args) => { const list = numbers(args); return list.length ? Math.max(...list) : 0; },
    COUNT: (args) => args.flat().filter((v) => typeof v === 'number').length,
    COUNTA: (args) => args.flat().filter((v) => v !== '').length,
    ROUND: ([value, digits = 0]) => {
      const k = 10 ** num(digits);
      return Math.round(num(value) * k) / k;
    },
    ABS: ([value]) => Math.abs(num(value)),
    IF: ([test, yes = true, no = false]) => (num(test) ? yes : no),
    AND: (args) => args.flat().every((v) => num(v)),
    OR: (args) => args.flat().some((v) => num(v)),
    NOT: ([value]) => !num(value),
    CONCAT: (args) => args.flat().map(text).join(''),
  };
  FUNCTIONS.CONCATENATE = FUNCTIONS.CONCAT;

  let worked = new Map();
  const working = new Set();
  const valueAt = (r, c) => {
    const key = r + ',' + c;
    if (!worked.has(key)) {
      if (working.has(key)) fail('#CYCLE!');
      const written = raw(r, c);
      let value;
      if (written.startsWith('=')) {
        working.add(key);
        try { value = evaluate(written.slice(1)); }
        catch (error) { value = { error: error.code || '#ERROR!' }; }
        working.delete(key);
        if (Array.isArray(value)) value = { error: '#VALUE!' };
      } else value = literal(written);
      worked.set(key, value);
    }
    const value = worked.get(key);
    return value && value.error ? fail(value.error) : value;
  };
  const reference = (ref) => {
    const [from, to = from] = ref.split(':');
    const [r1, c1] = at(from);
    const [r2, c2] = at(to);
    if (from === to) return valueAt(r1, c1);
    const values = [];
    for (let r = Math.min(r1, r2); r <= Math.max(r1, r2); r++) {
      for (let c = Math.min(c1, c2); c <= Math.max(c1, c2); c++) values.push(valueAt(r, c));
    }
    return values;
  };
  const evaluate = (formula) => {
    const list = tokens(formula);
    let i = 0;
    const is = (op) => list[i] && list[i].op === op;
    const expect = (op) => (is(op) ? i++ : fail('#ERROR!'));
    const compare = (op, a, b) => {
      const order = typeof a === 'string' || typeof b === 'string'
        ? text(a).localeCompare(text(b), undefined, { sensitivity: 'accent' })
        : num(a) - num(b);
      return { '=': order === 0, '<>': order !== 0, '<': order < 0, '>': order > 0, '<=': order <= 0, '>=': order >= 0 }[op];
    };
    const comparison = () => {
      let left = joined();
      while (list[i] && ['=', '<>', '<', '>', '<=', '>='].includes(list[i].op)) {
        const op = list[i++].op;
        left = compare(op, left, joined());
      }
      return left;
    };
    const joined = () => {
      let left = sum();
      while (is('&')) { i++; left = text(left) + text(sum()); }
      return left;
    };
    const sum = () => {
      let left = product();
      while (is('+') || is('-')) {
        const op = list[i++].op;
        const right = product();
        left = op === '+' ? num(left) + num(right) : num(left) - num(right);
      }
      return left;
    };
    const product = () => {
      let left = power();
      while (is('*') || is('/')) {
        const op = list[i++].op;
        const right = num(power());
        if (op === '/' && right === 0) fail('#DIV/0!');
        left = op === '*' ? num(left) * right : num(left) / right;
      }
      return left;
    };
    const power = () => {
      let base = unary();
      while (is('^')) { i++; base = num(base) ** num(unary()); }
      return base;
    };
    const unary = () => {
      if (is('-')) { i++; return -num(unary()); }
      if (is('+')) { i++; return num(unary()); }
      let value = primary();
      while (is('%')) { i++; value = num(value) / 100; }
      return value;
    };
    const primary = () => {
      const token = list[i++];
      if (!token) fail('#ERROR!');
      if ('n' in token) return token.n;
      if ('s' in token) return token.s;
      if (token.ref) return reference(token.ref);
      if (token.name === 'TRUE' && !is('(')) return true;
      if (token.name === 'FALSE' && !is('(')) return false;
      if (token.name) {
        const run = FUNCTIONS[token.name];
        expect('(');
        const args = [];
        if (!is(')')) {
          args.push(comparison());
          while (is(',')) { i++; args.push(comparison()); }
        }
        expect(')');
        return run ? run(args) : fail('#NAME?');
      }
      if (token.op === '(') {
        const value = comparison();
        expect(')');
        return value;
      }
      return fail('#ERROR!');
    };
    const value = comparison();
    if (i < list.length) fail('#ERROR!');
    return value;
  };
  // What a cell reads as, and whether as a number.
  const shown = (r, c) => {
    try {
      const value = valueAt(r, c);
      if (typeof value === 'number') {
        return [Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(12))), 'number'];
      }
      if (typeof value === 'boolean') return [value ? 'TRUE' : 'FALSE', 'number'];
      return [value, ''];
    } catch (error) {
      return [error.code || '#ERROR!', 'error'];
    }
  };

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
