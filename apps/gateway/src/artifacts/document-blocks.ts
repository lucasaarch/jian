/**
 * The document editor's blocks (document-editor.ts, whose scope this runs in): turning a line
 * into a heading, a list, a quote; lists that indent; tables walked with Tab and Enter; and what
 * Enter, Backspace and Delete do where the browser's own would leave something Markdown cannot
 * hold, or write styles into the page.
 *
 * Every function that changes the page calls `record()` first, so the change is one step of the
 * editor's history; the caller then calls `settle()` and `mark()`, or the input that follows
 * does.
 *
 * No template literal inside: this file is one already.
 */
export const DOCUMENT_BLOCKS = String.raw`
const filled = (block) => {
  if (!block.textContent && !block.querySelector('br, img, input')) block.append(make('br'));
  return block;
};
const lineOf = (block) => [...block.childNodes].filter((node) => !nestedIn(block)(node));
// The space between a to-do's box and its words. A plain one there is dropped by the browser as
// soon as the words are typed after it; this one stays, and Markdown reads it as a space.
const GAP = '\u00a0';
const box = (checked) => {
  const input = make('input', { type: 'checkbox' });
  if (checked) input.setAttribute('checked', '');
  input.checked = Boolean(checked);
  return input;
};
// The last line inside a block of blocks, where the caret goes when it steps back into one.
const lastLine = (block) => {
  if (block.matches(TEXT) && block === blockOf(block.firstChild || block)) return block;
  const lines = [...block.querySelectorAll(TEXT)].filter(
    (line) => blockOf(line.firstChild || line) === line,
  );
  return lines[lines.length - 1] || block;
};

// An item taken out of its list as a paragraph in its place: the items after it go on in a list
// of their own after it, and its own sublist follows it.
const liftItem = (item) => {
  const list = item.parentElement;
  const held = checkboxOf(item);
  if (held) {
    const space = held.nextSibling;
    if (space && space.nodeType === 3) space.data = space.data.replace(/^[ \u00a0]/, '');
    held.remove();
  }
  const line = make('p');
  line.append(...lineOf(item));
  filled(line);
  const sub = [...item.children].filter((child) => LISTS.test(child.tagName));
  const rest = [];
  for (let next = item.nextElementSibling; next; next = next.nextElementSibling) rest.push(next);
  list.after(line);
  if (rest.length) {
    const tail = list.cloneNode(false);
    if (list.tagName === 'OL') {
      const index = [...list.children].indexOf(item);
      tail.setAttribute('start', String((Number(list.getAttribute('start')) || 1) + index + 1));
    }
    tail.append(...rest);
    line.after(tail);
  }
  if (sub.length) line.after(...sub);
  item.remove();
  if (!list.firstElementChild) list.remove();
  return line;
};
const indent = (item) => {
  const previous = item.previousElementSibling;
  if (!previous || previous.tagName !== 'LI') return;
  let sub = previous.lastElementChild;
  if (!sub || !LISTS.test(sub.tagName)) {
    sub = make(item.parentElement.tagName.toLowerCase());
    previous.append(sub);
  }
  sub.append(item);
};
const outdent = (item) => {
  const list = item.parentElement;
  const owner = list.parentElement;
  if (!owner || owner.tagName !== 'LI') return liftItem(item);
  const rest = [];
  for (let next = item.nextElementSibling; next; next = next.nextElementSibling) rest.push(next);
  if (rest.length) {
    let sub = item.lastElementChild;
    if (!sub || sub.tagName !== list.tagName) {
      sub = list.cloneNode(false);
      item.append(sub);
    }
    sub.append(...rest);
  }
  owner.after(item);
  if (!list.firstElementChild) list.remove();
  return item;
};
// A paragraph taken out of a quote or a callout where it stood: what followed it stays in one of
// its own after it.
const liftOut = (line) => {
  const holder = line.parentElement;
  const rest = [];
  for (let next = line.nextElementSibling; next; next = next.nextElementSibling) rest.push(next);
  holder.after(line);
  if (rest.length) {
    const tail = holder.cloneNode(false);
    tail.append(...rest);
    line.after(tail);
  }
  if (!holder.firstElementChild) holder.remove();
  return line;
};

/**
 * One line turned into another kind: 'p', 'h1' to 'h6', 'ul', 'ol', 'todo', 'quote', 'code' or
 * 'callout'. The words move with it. A list item becomes a paragraph first, out of its list,
 * unless it only changes between a bullet and a to-do. A new list joins the list just before or
 * after it, as Markdown would read two lists that touch. Returns the line the caret belongs in.
 */
const turnInto = (block, kind, option) => {
  if (block.tagName === 'LI') {
    const tag = block.parentElement.tagName;
    if (kind === 'todo' && tag === 'UL') {
      if (!checkboxOf(block)) block.prepend(box(option), GAP);
      return block;
    }
    if (kind === 'ul' && tag === 'UL') {
      const held = checkboxOf(block);
      if (held) {
        const space = held.nextSibling;
        held.remove();
        if (space && space.nodeType === 3 && !space.data.trim()) space.remove();
      }
      return block;
    }
    if (kind === 'ol' && tag === 'OL') return block;
    block = liftItem(block);
    if (kind === 'p') return block;
  }
  const line = lineOf(block);
  if (kind === 'p' || /^h[1-6]$/.test(kind)) {
    const made = make(kind);
    made.append(...line);
    block.replaceWith(filled(made));
    return made;
  }
  if (kind === 'ul' || kind === 'ol' || kind === 'todo') {
    const tag = kind === 'ol' ? 'OL' : 'UL';
    const item = make('li');
    if (kind === 'todo') item.append(box(option), GAP);
    item.append(...line);
    filled(item);
    const previous = block.previousElementSibling;
    const next = block.nextElementSibling;
    let list;
    if (previous && previous.tagName === tag) {
      list = previous;
      list.append(item);
      block.remove();
    } else {
      list = make(tag.toLowerCase());
      if (kind === 'ol' && option > 1) list.setAttribute('start', String(option));
      list.append(item);
      block.replaceWith(list);
    }
    if (
      next &&
      next !== list &&
      next.tagName === tag &&
      next.parentElement === list.parentElement
    ) {
      list.append(...next.children);
      next.remove();
    }
    return item;
  }
  if (kind === 'quote' || kind === 'callout') {
    const inner = make('p');
    inner.append(...line);
    const made = kind === 'quote' ? make('blockquote') : make('div', { class: 'callout' });
    made.append(filled(inner));
    block.replaceWith(made);
    return inner;
  }
  if (kind === 'code') {
    const code = make('code');
    if (option) code.className = 'language-' + option;
    code.textContent = line
      .map((node) => node.textContent)
      .join('')
      .replace(/\u200b/g, '');
    filled(code);
    const pre = make('pre');
    pre.append(code);
    block.replaceWith(pre);
    return pre;
  }
  return block;
};

const TABLE =
  '<table><thead><tr>' +
  '<th><br></th>'.repeat(3) +
  '</tr></thead><tbody>' +
  ('<tr>' + '<td><br></td>'.repeat(3) + '</tr>').repeat(2) +
  '</tbody></table>';
// A block of the menu put where the menu was opened: in place of the line if it is empty, else
// as a new line below it. A divider and a table always have a line after them to go on in.
const insertBlock = (kind, block) => {
  let line = block;
  if (!isEmpty(block)) {
    line = filled(make(block.tagName === 'LI' ? 'li' : 'p'));
    block.after(line);
  }
  if (kind === 'hr' || kind === 'table') {
    if (line.tagName === 'LI') line = liftItem(line);
    const made = kind === 'hr' ? make('hr') : make('div', {}, TABLE).firstChild;
    line.replaceWith(made);
    let after = made.nextElementSibling;
    if (!after || !paragraph(after)) {
      after = make('p', {}, '<br>');
      made.after(after);
    }
    placeIn(kind === 'table' ? made.querySelector('th') : after, false);
    return;
  }
  const made = turnInto(line, kind);
  placeIn(made.tagName === 'PRE' ? made : lastLine(made), made.tagName !== 'PRE');
};

// Every line the selection touches, turned into one kind, or back into paragraphs when they
// already all are that kind.
const linesIn = (at) =>
  [...root.querySelectorAll(TEXT)].filter(
    (line) =>
      at.intersectsNode(line) &&
      blockOf(line.firstChild || line) === line &&
      !/^(PRE|TD|TH)$/.test(line.tagName),
  );
const turnLines = (kind) => {
  const at = range();
  if (!at) return;
  const lines = linesIn(at);
  if (!lines.length) return;
  const same = (line) =>
    kind === 'todo'
      ? line.tagName === 'LI' && checkboxOf(line)
      : kind === 'ul' || kind === 'ol'
        ? line.tagName === 'LI' &&
          line.parentElement.tagName === kind.toUpperCase() &&
          !checkboxOf(line)
        : line.tagName === kind.toUpperCase();
  const back = kind !== 'p' && lines.every(same);
  record();
  const made = keeping(() => lines.map((line) => turnInto(line, back ? 'p' : kind)));
  // An empty line is replaced whole, and the caret with it.
  const now = range();
  if (!now || !blockOf(now.startContainer)) placeIn(made[made.length - 1], true);
  settle();
  mark();
};

// Tables: Tab walks the cells and adds a row past the last; Enter goes down a row.
const addRow = (table) => {
  const rows = table.rows;
  const row = make('tr');
  for (let i = 0; i < rows[rows.length - 1].cells.length; i++) row.append(make('td', {}, '<br>'));
  (table.tBodies[0] || table.appendChild(make('tbody'))).append(row);
  return row;
};
const cellStep = (cell, back) => {
  const table = cell.closest('table');
  const cells = [...table.querySelectorAll('th, td')];
  let index = cells.indexOf(cell) + (back ? -1 : 1);
  if (index < 0) return;
  if (index >= cells.length) {
    record();
    addRow(table);
    mark();
    index = cells.length;
  }
  const next = table.querySelectorAll('th, td')[index];
  const all = document.createRange();
  all.selectNodeContents(next);
  select(all);
};
const cellDown = (cell) => {
  const row = cell.parentElement;
  const table = cell.closest('table');
  const rows = [...table.rows];
  let next = rows[rows.indexOf(row) + 1];
  if (!next) {
    record();
    next = addRow(table);
    mark();
  }
  placeIn(next.cells[Math.min(row.cells.length - 1, [...row.cells].indexOf(cell))], true);
};

// Text put in where the caret is, with the caret after it: what Enter and Tab write in code.
// A new line that ends the code gets a <br> after it: a browser neither shows a last line break
// in code nor keeps it, and deletes it as soon as something is typed before it. Saved, the <br>
// is that line break (markdown-frame.ts).
const insertPlain = (text) => {
  const at = range();
  at.deleteContents();
  const node = document.createTextNode(text);
  at.insertNode(node);
  const code = elementOf(node).closest('pre');
  if (code && text.endsWith('\n')) {
    const rest = document.createRange();
    rest.setStartAfter(node);
    rest.setEnd(code, code.childNodes.length);
    const after = rest.cloneContents();
    if (!after.textContent && !after.querySelector('br')) node.after(make('br'));
  }
  place(node, node.length);
};

const enter = () => {
  const at = range();
  const block = at && blockOf(at.startContainer);
  if (!block) return false;
  if (block.tagName === 'PRE') {
    record();
    insertPlain('\n');
    return true;
  }
  if (/^T[HD]$/.test(block.tagName)) {
    cellDown(block);
    return true;
  }
  if (!at.collapsed) return false;
  const fence = paragraph(block) && /^\x60{3}([\w+#.-]*)$/.exec(ownText(block).trim());
  if (fence && atEnd(block, at)) {
    record();
    block.replaceChildren(make('br'));
    placeIn(turnInto(block, 'code', fence[1]), false);
    return true;
  }
  if (block.tagName === 'LI' && isEmpty(block)) {
    record();
    placeIn(keeping(() => outdent(block)) || block, true);
    return true;
  }
  if (paragraph(block) && isEmpty(block) && block.parentElement.matches('blockquote, .callout')) {
    record();
    placeIn(liftOut(block), false);
    return true;
  }
  // A new paragraph after a heading or at the end of one, written here so that every browser
  // makes a paragraph and none carries bold or a link into it.
  if ((/^H[1-6]$/.test(block.tagName) || paragraph(block)) && atEnd(block, at)) {
    record();
    const line = make('p', {}, '<br>');
    block.after(line);
    place(line, 0);
    return true;
  }
  return false;
};
const lineBreak = () => {
  const at = range();
  const block = at && blockOf(at.startContainer);
  if (!block || block.tagName !== 'PRE') return false;
  record();
  insertPlain('\n');
  return true;
};
// The item Enter made in a to-do list is a to-do too.
const continueTodo = () => {
  const at = range();
  const item = at && elementOf(at.startContainer).closest('li');
  if (!item || !root.contains(item) || checkboxOf(item)) return;
  const previous = item.previousElementSibling;
  if (previous && previous.tagName === 'LI' && checkboxOf(previous)) {
    keeping(() => item.prepend(box(false), GAP));
    keepOffCheckbox();
  }
};

// Two lines made one, here and never by the browser, which writes the joined words' old size
// into the page as a style. A joined item's sublist comes along; the caret goes where they meet.
const join = (into, from) => {
  const last = into.lastChild;
  if (last && last.nodeName === 'BR') last.remove();
  const pin = document.createTextNode('');
  const sub = [...into.children].find((child) => LISTS.test(child.tagName));
  if (sub) sub.before(pin);
  else into.append(pin);
  pin.after(...lineOf(from).filter((node) => node.nodeName !== 'BR' || node.nextSibling));
  const lists = [...from.children].filter((child) => LISTS.test(child.tagName));
  if (lists.length && into.tagName === 'LI') into.append(...lists);
  else if (lists.length) into.after(...lists);
  const holder = from.parentElement;
  from.remove();
  if (LISTS.test(holder.tagName) && !holder.firstElementChild) holder.remove();
  filled(into);
  place(pin, 0);
};
// Delete at the end of a line joins the next one to it, as Backspace does from the other side.
const forwardDelete = () => {
  const at = range();
  const block = at && blockOf(at.startContainer);
  if (!block || !at.collapsed || !atEnd(block, at)) return false;
  if (/^(T[HD]|PRE)$/.test(block.tagName)) return true;
  let next;
  if (block.tagName === 'LI') {
    const sub = [...block.children].find((child) => LISTS.test(child.tagName));
    next = sub ? sub.firstElementChild : block.nextElementSibling;
    if (!next || next.tagName !== 'LI') return false;
  } else {
    next = block.nextElementSibling;
    if (!next) return block.parentElement === root;
    if (next.tagName === 'HR') {
      record();
      next.remove();
      return true;
    }
    if (LISTS.test(next.tagName)) next = next.firstElementChild;
    else if (!(paragraph(next) || /^H[1-6]$/.test(next.tagName))) return false;
  }
  record();
  join(block, next);
  return true;
};

const backspace = () => {
  const at = range();
  const block = at && blockOf(at.startContainer);
  if (!block || !atStart(block, at)) return false;
  const tag = block.tagName;
  if (/^T[HD]$/.test(tag)) return true;
  if (tag === 'PRE') {
    if (block.textContent.replace(/\n$/, '')) return true;
    record();
    const line = make('p', {}, '<br>');
    block.replaceWith(line);
    place(line, 0);
    return true;
  }
  if (/^H[1-6]$/.test(tag)) {
    record();
    placeIn(
      keeping(() => turnInto(block, 'p')),
      false,
    );
    return true;
  }
  if (tag === 'LI') {
    record();
    const was = at.startContainer;
    const made = keeping(() => outdent(block));
    if (!made.contains(was)) placeIn(made, false);
    return true;
  }
  const holder = block.parentElement;
  if (holder.matches('blockquote, .callout') && block === holder.firstElementChild) {
    record();
    keeping(() => liftOut(block));
    return true;
  }
  const previous = block.previousElementSibling;
  if (!previous) return holder === root;
  if (previous.tagName === 'HR') {
    record();
    previous.remove();
    return true;
  }
  if (paragraph(previous) || /^H[1-6]$/.test(previous.tagName) || LISTS.test(previous.tagName)) {
    const into = LISTS.test(previous.tagName) ? lastLine(previous) : previous;
    if (into.tagName === 'PRE') return false;
    record();
    join(into, block);
    return true;
  }
  if (isEmpty(block)) {
    record();
    block.remove();
    placeIn(lastLine(previous), true);
    return true;
  }
  placeIn(lastLine(previous), true);
  return true;
};

const tab = (back) => {
  const at = range();
  const block = at && blockOf(at.startContainer);
  if (!block) return;
  if (/^T[HD]$/.test(block.tagName)) return cellStep(block, back);
  if (block.tagName === 'PRE') {
    if (back) return;
    record();
    insertPlain('  ');
    return settle();
  }
  const item = block.closest('li');
  if (!item || !root.contains(item)) return;
  record();
  keeping(() => (back ? outdent(item) : indent(item)));
  settle();
  mark();
};
// Mod+Enter ticks a to-do, and anywhere else leaves the block the caret is in for a new
// paragraph after it: the way out of code, a quote or a table.
const modEnter = () => {
  const at = range();
  const block = at && blockOf(at.startContainer);
  if (!block) return;
  const held = block.tagName === 'LI' && checkboxOf(block);
  record();
  if (held) {
    const on = !held.hasAttribute('checked');
    held.toggleAttribute('checked', on);
    held.checked = on;
  } else {
    const line = make('p', {}, '<br>');
    topOf(block).after(line);
    place(line, 0);
  }
  settle();
  mark();
};
// An arrow past a code block, a table or a quote at either end of the document makes a
// paragraph there, since nothing else would let the caret out of it.
const leaveEdge = (down) => {
  const at = range();
  if (!at || !at.collapsed) return false;
  const top = topOf(at.startContainer);
  if (!top || top !== (down ? root.lastElementChild : root.firstElementChild)) return false;
  if (!top.matches('pre, table, blockquote, .callout')) return false;
  const caret = caretBox(at);
  const edge = top.getBoundingClientRect();
  if (down ? edge.bottom - caret.bottom > 28 : caret.top - edge.top > 28) return false;
  record();
  const line = make('p', {}, '<br>');
  if (down) root.append(line);
  else root.prepend(line);
  place(line, 0);
  settle();
  mark();
  return true;
};
`;
