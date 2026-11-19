/**
 * What a spreadsheet's source means, as script kept as text: the body of
 * `(source) => { … }` that reads the CSV into `rows` and works each cell out (`valueAt`,
 * `shown`), formulas included, with no page in reach. It also moves formulas as rows and
 * columns are put in or taken out (`reshape`), or as a formula is copied elsewhere (`moved`).
 *
 * The frame draws it (sheet-frame.ts) and the gateway runs the very same text to cache a
 * formula's value in an Excel file (sheet-export.ts), so the file and the panel can never
 * disagree on what a formula is worth.
 *
 * No template literal inside: this file is one already.
 */
export const SHEET_MODEL = String.raw`
  // CSV, or with a tab for a separator what a spreadsheet puts on the clipboard.
  const parse = (text, sep = ',') => {
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
      else if (c === sep) { row.push(cell); cell = ''; }
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

  // Every reference written in a formula, handed to change as its ends ({ r, c, fixedR, fixedC },
  // one for B2, two for B2:C9), and put back as change answers, or as it was for null. Text in
  // quotes is no reference, and neither is part of a longer word: LOG10( is a function.
  const REF = /(\$?)([A-Za-z]{1,3})(\$?)(\d+)(?::(\$?)([A-Za-z]{1,3})(\$?)(\d+))?/y;
  const rewrite = (formula, change) => {
    let out = '';
    for (let i = 0; i < formula.length;) {
      if (formula[i] === '"') {
        let j = i + 1;
        while (j < formula.length && !(formula[j] === '"' && formula[j + 1] !== '"')) {
          j += formula[j] === '"' ? 2 : 1;
        }
        out += formula.slice(i, j + 1);
        i = j + 1;
        continue;
      }
      REF.lastIndex = i;
      const m = /[A-Za-z0-9_.$]/.test(formula[i - 1] || '') ? null : REF.exec(formula);
      if (m && !/[A-Za-z0-9_.(]/.test(formula[i + m[0].length] || '')) {
        const end = (fixedC, column, fixedR, row) =>
          ({ r: Number(row) - 1, c: columnOf(column.toUpperCase()), fixedR: !!fixedR, fixedC: !!fixedC });
        const ends = m[6] ? [end(m[1], m[2], m[3], m[4]), end(m[5], m[6], m[7], m[8])] : [end(m[1], m[2], m[3], m[4])];
        const put = ends.some((e) => e.r < 0) ? null : change(ends);
        out += put === null ? m[0] : put;
        i += m[0].length;
        continue;
      }
      out += formula[i];
      i++;
    }
    return out;
  };
  const named = (ends) =>
    ends.map((e) => (e.fixedC ? '$' : '') + letters(e.c) + (e.fixedR ? '$' : '') + (e.r + 1)).join(':');

  // A formula once rows (axis 'r') or columns (axis 'c') are put in before index at (count > 0)
  // or taken out from it (count < 0), as Excel moves it: what was past them moves with them, a
  // range they cut through grows or shrinks, and what pointed only at cells taken out is #REF!.
  // A $ does not hold a reference in place here; it only holds it when copied.
  const shifted = (formula, axis, at, count) =>
    rewrite(formula, (ends) => {
      if (count > 0) {
        if (!ends.some((e) => e[axis] >= at)) return null;
        return named(ends.map((e) => ({ ...e, [axis]: e[axis] >= at ? e[axis] + count : e[axis] })));
      }
      const past = at - count;
      const low = Math.min(...ends.map((e) => e[axis]));
      const high = Math.max(...ends.map((e) => e[axis]));
      if (high < at) return null;
      if (low >= at && high < past) return '#REF!';
      return named(ends.map((e) => {
        const p = e[axis];
        const moved = p < at ? p : p >= past ? p + count : p === low ? at : at - 1;
        return { ...e, [axis]: moved };
      }));
    });

  // A formula copied rows and columns away: what is not held by a $ moves as far, and a
  // reference pushed off the top or the left is #REF!.
  const moved = (formula, rows, columns) =>
    rewrite(formula, (ends) => {
      const next = ends.map((e) => ({
        ...e,
        r: e.fixedR ? e.r : e.r + rows,
        c: e.fixedC ? e.c : e.c + columns,
      }));
      return next.some((e) => e.r < 0 || e.c < 0) ? '#REF!' : named(next);
    });

  const fail = (code) => { const error = new Error(code); error.code = code; throw error; };
  const TOKEN = /\s*(?:(\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|("(?:[^"]|"")*")|(\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?)|([A-Za-z_][A-Za-z0-9_.]*)|(<>|<=|>=|[-+*\/^&=<>(),%])|(#REF!))/y;
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
      else if (m[5]) found.push({ op: m[5] });
      else found.push({ lost: true });
    }
    return found;
  };

  let rows = parse(source);
  // Rows or columns put in or taken out of the sheet itself, every formula following them.
  const reshape = (axis, at, count) => {
    const blank = (n, fill) => Array.from({ length: n }, fill);
    if (axis === 'r') {
      if (count < 0) rows.splice(at, -count);
      else if (at < rows.length) rows.splice(at, 0, ...blank(count, () => []));
    } else {
      for (const row of rows) {
        if (count < 0) row.splice(at, -count);
        else if (at < row.length) row.splice(at, 0, ...blank(count, () => ''));
      }
    }
    for (const row of rows) {
      for (let c = 0; c < row.length; c++) {
        if (row[c].startsWith('=')) row[c] = '=' + shifted(row[c].slice(1), axis, at, count);
      }
    }
  };
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
      if (token.lost) fail('#REF!');
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
