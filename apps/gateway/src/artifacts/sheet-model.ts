/**
 * What a spreadsheet's source means, as script kept as text: the body of
 * `(source) => { … }` that reads the CSV into `rows` and works each cell out (`valueAt`,
 * `shown`), formulas included, with no page in reach.
 *
 * The frame draws it (sheet-frame.ts) and the gateway runs the very same text to cache a
 * formula's value in an Excel file (sheet-export.ts), so the file and the panel can never
 * disagree on what a formula is worth.
 *
 * No template literal inside: this file is one already.
 */
export const SHEET_MODEL = String.raw`
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

`;
