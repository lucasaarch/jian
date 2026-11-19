/**
 * The document editor's marks and the Markdown typed as shortcuts (document-editor.ts, whose
 * scope this runs in): bold, italic, strikethrough and code put on a selection or taken off it,
 * and `## `, `- `, `[] `, `**bold**` or a backtick pair turned into what they say as they are
 * typed. Each change is one step of the editor's history, so undo brings back what was typed.
 *
 * No template literal inside: this file is one already.
 */
export const DOCUMENT_MARKS = String.raw`
// Marks. Each is one of a few tags, and a selection across several gets the mark on each piece
// of text in it, joined again where two pieces touch.
const MARKS = {
  bold: ['STRONG', 'B'],
  italic: ['EM', 'I'],
  strike: ['DEL', 'S', 'STRIKE'],
  code: ['CODE'],
};
const markOf = (node, name) => {
  for (let at = elementOf(node); at && at !== root && !at.matches(TEXT); at = at.parentElement) {
    if (MARKS[name].includes(at.tagName)) return at;
  }
  return null;
};
const textsIn = (at) => {
  const { startContainer: start, startOffset, endContainer: end, endOffset } = at;
  if (end.nodeType === 3 && endOffset < end.length && endOffset > 0) end.splitText(endOffset);
  let first = start;
  if (start.nodeType === 3 && startOffset > 0 && startOffset < start.length) {
    first = start.splitText(startOffset);
    if (end === start) at.setEnd(first, endOffset - startOffset);
  }
  if (first !== start) at.setStart(first, 0);
  const holder = at.commonAncestorContainer;
  const walker = document.createTreeWalker(
    holder.nodeType === 3 ? holder.parentNode : holder,
    NodeFilter.SHOW_TEXT,
  );
  const texts = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!at.intersectsNode(node) || !node.data) continue;
    if (node === at.startContainer && at.startOffset >= node.length) continue;
    if (node === at.endContainer && at.endOffset === 0) continue;
    const block = blockOf(node);
    if (!block || block.tagName === 'PRE') continue;
    texts.push(node);
  }
  return texts;
};
// A copy of the mark around only this text, the mark's other words split off into copies of it
// before and after, so that taking it off leaves them as they were.
const isolate = (mark, node) => {
  const before = document.createRange();
  before.setStartBefore(mark);
  before.setEndBefore(node);
  mark.before(before.extractContents());
  const after = document.createRange();
  after.setStartAfter(node);
  after.setEndAfter(mark);
  mark.after(after.extractContents());
};
const MARK_TAG = { bold: 'strong', italic: 'em', strike: 'del', code: 'code' };
const dropEmpty = (holder) => {
  for (const element of holder.querySelectorAll('strong, b, em, i, del, s, strike, code, a')) {
    if (!element.textContent && !element.querySelector('img, br') && !element.closest('pre'))
      element.remove();
  }
};
// The caret put just past an element, on a character of nothing, so that what is typed next
// stays outside it: a browser left to itself types into the element. The character is never
// saved.
const stepOut = (element) => {
  const space = document.createTextNode('\u200b');
  element.after(space);
  place(space, 1);
};
const toggleMark = (name) => {
  const at = range();
  if (!at) return;
  record();
  if (at.collapsed) {
    const held = markOf(at.startContainer, name);
    if (held) stepOut(held);
    else {
      const made = make(MARK_TAG[name]);
      made.textContent = '\u200b';
      at.insertNode(made);
      place(made.firstChild, 1);
    }
    return settle();
  }
  const texts = textsIn(at);
  if (!texts.length) return;
  const on = texts.every((node) => !node.data.trim() || markOf(node, name));
  for (const node of texts) {
    const held = markOf(node, name);
    if (on && held) {
      isolate(held, node);
      const kept = markOf(node, name);
      if (kept) kept.replaceWith(...kept.childNodes);
    } else if (!on && !held) {
      const made = make(MARK_TAG[name]);
      node.replaceWith(made);
      made.append(node);
      const previous = made.previousSibling;
      if (previous && previous.nodeType === 1 && previous.tagName === made.tagName) {
        previous.append(...made.childNodes);
        made.remove();
      }
    }
  }
  for (const block of new Set(texts.map(blockOf))) {
    dropEmpty(block);
    block.normalize();
  }
  const first = texts.find((node) => node.isConnected);
  const last = [...texts].reverse().find((node) => node.isConnected);
  if (first && last) {
    const back = document.createRange();
    back.setStart(first, 0);
    back.setEnd(last, last.length);
    select(back);
  }
  settle();
  mark();
};

// Markdown typed as shortcuts. At the start of a line, before the space that ends them; inside
// one, as the closing mark is typed.
const SHORT = [
  [/^(#{1,6}) $/, (m) => ['h' + m[1].length]],
  [/^[-*+] $/, () => ['ul']],
  [/^(\d{1,9})[.)] $/, (m) => ['ol', Number(m[1])]],
  [/^\[([ xX]?)\] $/, (m) => ['todo', Boolean(m[1].trim())]],
  [/^> $/, () => ['quote']],
  [/^\x60{3}([\w+#.-]*) $/, (m) => ['code', m[1]]],
];
const INLINE = [
  [/\*\*([^*\s](?:[^*]*[^*\s])?)\*\*$/, 'strong'],
  [/__([^_\s](?:[^_]*[^_\s])?)__$/, 'strong'],
  [/(?:^|[^*])\*([^*\s](?:[^*]*[^*\s])?)\*$/, 'em'],
  [/(?:^|[^_\w])_([^_\s](?:[^_]*[^_\s])?)_$/, 'em'],
  [/~~([^~\s](?:[^~]*[^~\s])?)~~$/, 'del'],
  [/\x60([^\x60]+)\x60$/, 'code'],
];
const typed = (char) => {
  const at = range();
  if (!at || !at.collapsed || at.startContainer.nodeType !== 3) return;
  const node = at.startContainer;
  const block = blockOf(node);
  if (!block || block.tagName === 'PRE' || elementOf(node).closest('code')) return;
  if (char === '/') return slashTyped(node, at.startOffset - 1);
  if (char === ' ' && !/^T[HD]$/.test(block.tagName)) {
    const before = textBefore(block, at);
    for (const [pattern, read] of SHORT) {
      const found = pattern.exec(before);
      if (!found) continue;
      const [kind, option] = read(found);
      const allowed =
        block.tagName === 'LI'
          ? kind === 'todo' && !checkboxOf(block) && block.parentElement.tagName === 'UL'
          : paragraph(block) || (/^H[1-6]$/.test(block.tagName) && kind[0] === 'h');
      if (!allowed) return;
      record();
      const cut = document.createRange();
      cut.selectNodeContents(block);
      cut.setEnd(at.startContainer, at.startOffset);
      cut.deleteContents();
      const made = turnInto(block, kind, option);
      placeIn(made, false);
      return;
    }
    return;
  }
  if (char === '-' && paragraph(block) && ownText(block).trim() === '---' && atEnd(block, at)) {
    record();
    block.replaceChildren(make('br'));
    return insertBlock('hr', block);
  }
  if (!/^[*_~\x60]$/.test(char)) return;
  const before = node.data.slice(0, at.startOffset);
  for (const [pattern, tag] of INLINE) {
    const found = pattern.exec(before);
    if (!found) continue;
    const size = tag === 'em' || tag === 'code' ? 1 : 2;
    const start = at.startOffset - found[1].length - size * 2;
    record();
    node.splitText(at.startOffset);
    const marked = node.splitText(start);
    const made = make(tag);
    made.textContent = found[1];
    marked.replaceWith(made);
    stepOut(made);
    return;
  }
};
`;
