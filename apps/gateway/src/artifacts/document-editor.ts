import { ARTIFACT_EDIT_MESSAGE } from '@jian/contracts';
import { DOCUMENT_BLOCKS } from './document-blocks.js';
import { DOCUMENT_CLIPBOARD } from './document-clipboard.js';
import { DOCUMENT_EDITOR_STYLE } from './document-editor-style.js';
import { DOCUMENT_MARKS } from './document-marks.js';
import { DOCUMENT_MENUS } from './document-menus.js';
import { MARKDOWN } from './markdown-frame.js';

/**
 * The editor of a Markdown document: the whole page is one surface to write on, as in a notes
 * app, rather than a page whose blocks are opened one at a time (edit-frame.ts, which web pages
 * and slides keep). It is script for the frame's page, kept as text, and defines
 * `const editing = (source, options) => …` with the frame page's `root`, `run` and `read` in
 * reach. The parts (document-blocks.ts, document-marks.ts, document-menus.ts,
 * document-clipboard.ts) run in this same scope, one after the other, and use what this part
 * defines.
 *
 * - The document is drawn as it is read (marked), and `root` itself is made editable: a click
 *   anywhere is a caret, a selection runs across paragraphs, Enter, Backspace and the arrows work
 *   as in any editor. What the browser does well (typing, splitting a list item) it does; what it
 *   does differently in each browser, or by writing styles into the page (merging a heading into
 *   a paragraph, bold in a heading), is done here.
 * - Every change, the browser's and this script's, is kept by this script's own history, so
 *   undo walks back over a block turned into a heading as it does over typing. The browser's own
 *   undo is refused: it knows nothing of what this script changed and would undo it wrongly.
 * - What is saved is Markdown again (markdown-frame.ts), read from a copy of the page with
 *   everything this script added taken out: attributes marked `data-jian-*`, the editable flag,
 *   and the invisible space that keeps the caret outside a bold word just closed.
 * - Like every editing frame it answers its parent only when asked (`collect`), and otherwise
 *   says only that something changed. The source is read as a document and never run: marked's
 *   markup goes through a `DOMParser`, whose scripts never start.
 *
 * No template literal inside: this file is one already.
 */
const CORE = String.raw`
const KEY = ${JSON.stringify(ARTIFACT_EDIT_MESSAGE)};
// What holds a line of text: the caret is always in one of these, never in the root itself.
const TEXT = 'p, h1, h2, h3, h4, h5, h6, li, pre, td, th, div';
const HOLDS = ':scope > :is(p, h1, h2, h3, h4, h5, h6, ul, ol, pre, blockquote, table, div)';
const LISTS = /^(UL|OL)$/;
const MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

let changed = false;
// Tells the panel something changed, never what: it asks for the document when it wants to save.
const mark = () => {
  changed = true;
  parent.postMessage({ [KEY]: { changed: true } }, '*');
};

const make = (tag, attributes, html) => {
  const node = document.createElement(tag);
  for (const name in attributes || {}) node.setAttribute(name, attributes[name]);
  if (html) node.innerHTML = html;
  return node;
};
const elementOf = (node) => (node && node.nodeType !== 1 ? node.parentElement : node);
// The block a point's text belongs to. A div that holds blocks (a callout) is not one: its
// paragraphs are.
const blockOf = (node) => {
  for (let at = elementOf(node); at && at !== root; at = at.parentElement) {
    if (at.matches(TEXT) && !(at.tagName === 'DIV' && at.querySelector(HOLDS))) return at;
  }
  return null;
};
const topOf = (node) => {
  let at = elementOf(node);
  while (at && at.parentElement !== root) at = at.parentElement;
  return at && at.parentElement === root ? at : null;
};
const paragraph = (block) =>
  block && (block.tagName === 'P' || (block.tagName === 'DIV' && !block.className));
const checkboxOf = (item) => {
  const first = [...item.childNodes].find((node) => node.nodeType !== 3 || node.data.trim());
  return first && first.nodeType === 1 && first.matches('input[type=checkbox]') ? first : null;
};
const nestedIn = (block) => (node) =>
  node.nodeType === 1 && (LISTS.test(node.tagName) || node === checkboxOf(block));
// The text a block shows as its own line: an item's sublist and checkbox are not part of it.
const ownText = (block) => {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let text = '';
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (blockOf(node) === block) text += node.data;
  }
  return text;
};
const isEmpty = (block) =>
  !ownText(block).replace(/[\s\u200b]/g, '') && !block.querySelector('img, hr, table');

const range = () => {
  const selection = getSelection();
  if (!selection.rangeCount) return null;
  const at = selection.getRangeAt(0);
  return root.contains(at.startContainer) && root.contains(at.endContainer) ? at : null;
};
const select = (given) => {
  const selection = getSelection();
  selection.removeAllRanges();
  selection.addRange(given);
};
const place = (node, offset) => {
  const at = document.createRange();
  at.setStart(node, offset);
  at.collapse(true);
  select(at);
};
// The caret at the start or the end of a block's own line.
const placeIn = (block, end) => {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let found = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (blockOf(node) !== block) continue;
    found = node;
    if (!end) break;
  }
  if (found) return place(found, end ? found.length : 0);
  const box = block.tagName === 'LI' && checkboxOf(block);
  place(block, box ? [...block.childNodes].indexOf(box) + 1 : 0);
};
const textBefore = (block, at) => {
  const before = document.createRange();
  before.selectNodeContents(block);
  before.setEnd(at.startContainer, at.startOffset);
  // Space at the start of a line shows nothing, so it is nothing to a shortcut either.
  return before
    .toString()
    .replace(/\u00a0/g, ' ')
    .replace(/\u200b/g, '')
    .replace(/^\s+/, '');
};
const atStart = (block, at) => at.collapsed && textBefore(block, at) === '';
const atEnd = (block, at) => {
  const after = document.createRange();
  after.setStart(at.startContainer, at.startOffset);
  const sub = [...block.children].find((child) => LISTS.test(child.tagName));
  if (sub) after.setEndBefore(sub);
  else after.setEnd(block, block.childNodes.length);
  return !after.toString().replace(/[\u200b\n]/g, '');
};
// Runs a change that moves nodes around and puts the selection back on the same text, which
// the browser would otherwise drop when a node holding it leaves its place.
const keeping = (change) => {
  const at = range();
  const held = at && [at.startContainer, at.startOffset, at.endContainer, at.endOffset];
  const made = change();
  if (held && held[0].isConnected && held[2].isConnected && root.contains(held[0])) {
    try {
      const back = document.createRange();
      back.setStart(held[0], held[1]);
      back.setEnd(held[2], held[3]);
      select(back);
    } catch {}
  }
  return made;
};
const caretBox = (at) => {
  const rects = at.getClientRects();
  if (rects.length) return rects[rects.length - 1];
  const holder = blockOf(at.startContainer) || elementOf(at.startContainer);
  return holder.getBoundingClientRect();
};

// History. A point is kept as elements counted from the root and characters inside the last
// one, which still finds the same place after the page is written out and read back, where
// text nodes that were apart come back as one.
const pointOf = (node, offset) => {
  const holder = elementOf(node);
  const before = document.createRange();
  before.selectNodeContents(holder);
  before.setEnd(node, offset);
  const path = [];
  for (let at = holder; at && at !== root; at = at.parentElement) {
    path.unshift([...at.parentElement.children].indexOf(at));
  }
  return [path, before.toString().length];
};
const nodeOf = ([path, chars]) => {
  let holder = root;
  for (const index of path) holder = (holder && holder.children[index]) || holder;
  const walker = document.createTreeWalker(holder, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (chars <= node.length) return [node, chars];
    chars -= node.length;
  }
  return [holder, 0];
};
const snapshot = () => {
  const at = range();
  return {
    html: root.innerHTML,
    at: at && [pointOf(at.startContainer, at.startOffset), pointOf(at.endContainer, at.endOffset)],
  };
};
const past = [];
const future = [];
// Typing, or deleting, in one stretch is one step to undo, as it is everywhere else.
let streak = '';
let streakAt = 0;
const record = (kind) => {
  const now = Date.now();
  if (kind && kind === streak && now - streakAt < 1200) {
    streakAt = now;
    return;
  }
  past.push(snapshot());
  if (past.length > 300) past.shift();
  future.length = 0;
  streak = kind || '';
  streakAt = now;
};
const travel = (from, to) => {
  const state = from.pop();
  if (!state) return;
  to.push(snapshot());
  root.innerHTML = state.html;
  root.focus({ preventScroll: true });
  if (state.at) {
    const [start, end] = state.at.map(nodeOf);
    const back = document.createRange();
    back.setStart(start[0], start[1]);
    back.setEnd(end[0], end[1]);
    select(back);
  }
  streak = '';
  settle();
  mark();
};
const undo = () => travel(past, future);
const redo = () => travel(future, past);

// What may stand in the root by itself; anything else there is words that need a paragraph.
const OWN_BLOCKS =
  'p, h1, h2, h3, h4, h5, h6, ul, ol, pre, blockquote, table, div, hr, details, figure, ' +
  'section, aside, dl, iframe, img';
// What a change leaves for the next one: text typed straight into the root is put in a
// paragraph, an emptied list goes, and the root always holds a line to write on.
const tidy = () => {
  keeping(() => {
    let run = [];
    const wrap = () => {
      if (run.some((node) => node.nodeType === 1 || node.data.trim())) {
        const line = make('p');
        run[0].before(line);
        line.append(...run);
      } else for (const node of run) node.remove();
      run = [];
    };
    for (const child of [...root.childNodes]) {
      const loose = child.nodeType === 3 || (child.nodeType === 1 && !child.matches(OWN_BLOCKS));
      if (loose && child.nodeType !== 8) run.push(child);
      else if (run.length) wrap();
    }
    if (run.length) wrap();
    for (const list of root.querySelectorAll('ul, ol, blockquote')) {
      if (!list.firstElementChild && !list.textContent.trim()) list.remove();
    }
  });
  if (!root.firstElementChild) {
    const line = make('p', {}, '<br>');
    root.append(line);
    if (document.activeElement === root) place(line, 0);
  }
};
// A merge of two blocks of different sizes is where the browser writes styles into the page, to
// keep the merged words looking as they did: a span, or a style on a bold word. A document has
// no such styles to keep. What was styled before the browser's change (styledBefore, taken as
// it starts) is the document's own, and stays; a styled word the browser writes anew while it
// merges loses its style with the rest, which a Markdown document seldom has.
const STYLED = '[style], span, font';
let styledBefore = new Set();
let merging = false;
const unstyle = () => {
  const added = [...root.querySelectorAll(STYLED)].filter((node) => !styledBefore.has(node));
  if (!added.length) return;
  keeping(() => {
    for (const node of added) {
      if (
        /^(SPAN|FONT)$/.test(node.tagName) &&
        [...node.attributes].every((a) => /^(style|face|color|size)$/.test(a.name))
      ) {
        node.replaceWith(...node.childNodes);
      } else node.removeAttribute('style');
    }
  });
};

// The grey words in an empty line: on an empty document always, on the line being written
// only while it is empty.
const HINTS = {
  P: 'Type \u2018/\u2019 for commands',
  DIV: 'Type \u2018/\u2019 for commands',
  H1: 'Heading 1',
  H2: 'Heading 2',
  H3: 'Heading 3',
  H4: 'Heading 4',
  H5: 'Heading 5',
  H6: 'Heading 6',
  LI: 'List',
};
let composing = false;
const hints = () => {
  if (composing) return;
  for (const held of root.querySelectorAll('[data-jian-hint]'))
    held.removeAttribute('data-jian-hint');
  const only = root.firstElementChild;
  if (only && only === root.lastElementChild && only.tagName === 'P' && isEmpty(only)) {
    only.setAttribute('data-jian-hint', 'Write something, or type \u2018/\u2019 for commands');
    return;
  }
  const at = range();
  if (!at || !at.collapsed || !document.hasFocus()) return;
  const block = blockOf(at.startContainer);
  if (!block || !HINTS[block.tagName] || !isEmpty(block)) return;
  let hint = HINTS[block.tagName];
  if (block.tagName === 'LI' && checkboxOf(block)) hint = 'To-do';
  else if (paragraph(block) && block.parentElement.tagName === 'BLOCKQUOTE') hint = 'Quote';
  block.setAttribute('data-jian-hint', hint);
};
// After every change: the page put right, the hints and the floating pieces where they belong.
const settle = () => {
  tidy();
  hints();
  follow();
};

// A copy of the page, or of a piece of it, as the document it is, with nothing of this script
// left in it.
const cleanCopy = (copy) => {
  for (const node of copy.querySelectorAll('[data-jian-edit]')) node.remove();
  for (const node of copy.querySelectorAll('*')) {
    for (const attribute of [...node.attributes]) {
      if (attribute.name.startsWith('data-jian') || attribute.name === 'contenteditable') {
        node.removeAttribute(attribute.name);
      }
    }
  }
  const walker = document.createTreeWalker(copy, NodeFilter.SHOW_TEXT);
  const spent = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.data.includes('\u200b')) continue;
    node.data = node.data.replace(/\u200b/g, '');
    if (!node.data) spent.push(node);
  }
  for (const node of spent) node.remove();
  return copy;
};
const cleaned = () => cleanCopy(root.cloneNode(true));

const keyName = (key, shift, alt) =>
  MAC
    ? (alt ? '\u2325' : '') + (shift ? '\u21e7' : '') + '\u2318' + key
    : 'Ctrl+' + (alt ? 'Alt+' : '') + (shift ? 'Shift+' : '') + key;

const editing = (source, options) => {
  run(read('libraries')[0]);
  const parsed = new DOMParser().parseFromString('<body>' + marked.parse(source), 'text/html');
  root.replaceChildren(...[...parsed.body.childNodes].map((node) => document.adoptNode(node)));
  prepare();
  const style = make('style', { 'data-jian-edit': '' });
  style.textContent = ${JSON.stringify(DOCUMENT_EDITOR_STYLE)};
  document.head.append(style);
  root.setAttribute('contenteditable', 'true');
  // Enter in a line the browser makes itself starts a paragraph, not a div.
  try {
    document.execCommand('defaultParagraphSeparator', false, 'p');
  } catch {}
  build();
  listen();
  hints();

  const told = (ask) => {
    if (!ask || typeof ask.collect !== 'string') return;
    const answer = changed ? { html: markdownOf(cleaned()) } : { unchanged: true };
    parent.postMessage({ [KEY]: { collect: ask.collect, ...answer } }, '*');
  };
  told(options);
  addEventListener('message', (event) => {
    if (event.source === parent && event.data) told(event.data[KEY]);
  });
};

// marked's markup made ready to write in: no blank text between blocks for the caret to fall
// into, checkboxes that take a click, and empty cells that hold a line to click into.
const prepare = () => {
  const BESIDE = /^(UL|OL|P|PRE|BLOCKQUOTE|TABLE|H[1-6])$/;
  const blank = (node) => {
    const holder = node.parentElement;
    if (node.data.trim() || holder.closest('pre')) return false;
    if (holder === root || holder.matches('ul, ol, blockquote, table, thead, tbody, tr, .callout'))
      return true;
    return (
      holder.tagName === 'LI' &&
      [node.previousSibling, node.nextSibling].some((next) => next && BESIDE.test(next.nodeName))
    );
  };
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const spent = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode())
    if (blank(node)) spent.push(node);
  for (const node of spent) node.remove();
  for (const box of root.querySelectorAll('input[type=checkbox]')) box.removeAttribute('disabled');
  for (const cell of root.querySelectorAll('th, td'))
    if (!cell.childNodes.length) cell.append(make('br'));
  tidy();
};

const listen = () => {
  root.addEventListener('beforeinput', (event) => {
    const type = event.inputType;
    if (type === 'historyUndo' || type === 'historyRedo') {
      event.preventDefault();
      return type === 'historyUndo' ? undo() : redo();
    }
    if (type.startsWith('format')) {
      event.preventDefault();
      const name = { formatBold: 'bold', formatItalic: 'italic', formatStrikeThrough: 'strike' }[
        type
      ];
      if (name) toggleMark(name);
      return;
    }
    if (type === 'insertFromDrop' || type === 'deleteByDrag') return event.preventDefault();
    if (event.isComposing) return;
    if (type === 'insertParagraph' && enter()) return event.preventDefault();
    if (type === 'insertLineBreak' && lineBreak()) return event.preventDefault();
    if (type === 'deleteContentBackward' && backspace()) return event.preventDefault();
    if (type === 'deleteContentForward' && forwardDelete()) return event.preventDefault();
    const at = range();
    merging = type.startsWith('delete') || Boolean(at && !at.collapsed);
    if (merging) styledBefore = new Set(root.querySelectorAll(STYLED));
    record(type === 'insertText' ? 'type' : type.startsWith('delete') ? 'delete' : '');
  });
  root.addEventListener('compositionstart', () => {
    composing = true;
    record('type');
  });
  root.addEventListener('compositionend', () => {
    composing = false;
    settle();
  });
  root.addEventListener('input', (event) => {
    const type = event.inputType || '';
    if (!composing) {
      if (type === 'insertText' && event.data) typed(event.data.slice(-1));
      if (type === 'insertParagraph') continueTodo();
      if (merging) unstyle();
      merging = false;
      settle();
    }
    mark();
  });
  root.addEventListener('keydown', (event) => {
    if (slashKey(event)) return;
    const mod = MAC ? event.metaKey : event.ctrlKey;
    const key = event.key.toLowerCase();
    const take = (action) => {
      event.preventDefault();
      action();
    };
    if (/^(arrow|page|home|end)/i.test(event.key)) streak = '';
    if (mod && !event.altKey) {
      if (key === 'z') return take(event.shiftKey ? redo : undo);
      if (key === 'y' && !MAC) return take(redo);
      if (key === 'b') return take(() => toggleMark('bold'));
      if (key === 'i') return take(() => toggleMark('italic'));
      if (key === 'e') return take(() => toggleMark('code'));
      if (key === 'u') return event.preventDefault();
      if (key === 'k') return take(startLink);
      if (event.shiftKey && (key === 's' || key === 'x')) return take(() => toggleMark('strike'));
      const lists = { Digit7: 'ol', Digit8: 'ul', Digit9: 'todo' };
      if (event.shiftKey && lists[event.code]) return take(() => turnLines(lists[event.code]));
      if (key === 'enter') return take(modEnter);
    }
    if (mod && event.altKey && /^Digit[0-6]$/.test(event.code)) {
      const level = event.code.slice(5);
      return take(() => turnLines(level === '0' ? 'p' : 'h' + level));
    }
    if (event.key === 'Tab' && !mod && !event.altKey) return take(() => tab(event.shiftKey));
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !event.shiftKey && !mod) {
      if (leaveEdge(event.key === 'ArrowDown')) event.preventDefault();
    }
    if (event.key === 'Escape') closeAll();
    hideHandle();
  });
  // No link is followed and nothing is dragged out of the page: a link here is text to edit,
  // and the frame has nowhere to go.
  root.addEventListener('click', (event) => {
    const box = event.target.closest && event.target.closest('input[type=checkbox]');
    if (box && root.contains(box)) {
      event.preventDefault();
      // The browser puts the box back as it was once a cancelled click is over.
      setTimeout(() => {
        box.checked = box.hasAttribute('checked');
      });
      return;
    }
    if (event.target.closest && event.target.closest('a')) event.preventDefault();
  });
  root.addEventListener('auxclick', (event) => event.preventDefault());
  root.addEventListener('dragstart', (event) => event.preventDefault());
  root.addEventListener('drop', (event) => event.preventDefault());
  document.addEventListener('mousedown', press, true);
  document.addEventListener('selectionchange', () => {
    keepOffCheckbox();
    hints();
    follow();
  });
  root.addEventListener('focus', hints);
  root.addEventListener('blur', () => setTimeout(hints));
  addEventListener('blur', () => setTimeout(hints));
  root.addEventListener('paste', paste);
  root.addEventListener('copy', (event) => copy(event, false));
  root.addEventListener('cut', (event) => copy(event, true));
};

// A press outside the text: below the last block it writes at the end, in a new paragraph if the
// document ends in something else; beside the column it puts the caret on the line beside it.
// A checkbox is ticked here, so the caret stays where it was.
const press = (event) => {
  if (event.button !== 0 || (event.target.closest && event.target.closest('[data-jian-edit]')))
    return;
  streak = '';
  const target = event.target;
  if (target.matches && target.matches('input[type=checkbox]') && root.contains(target)) {
    event.preventDefault();
    record();
    const on = !target.hasAttribute('checked');
    target.toggleAttribute('checked', on);
    target.checked = on;
    mark();
    return;
  }
  if (target !== root && target !== document.body && target !== document.documentElement) return;
  const last = root.lastElementChild;
  if (last && event.clientY > last.getBoundingClientRect().bottom) {
    event.preventDefault();
    root.focus({ preventScroll: true });
    let line = last;
    if (!paragraph(last)) {
      record();
      line = make('p', {}, '<br>');
      root.append(line);
      mark();
    }
    placeIn(line, true);
    settle();
    return;
  }
  if (target === root) return;
  event.preventDefault();
  const box = root.getBoundingClientRect();
  const style = getComputedStyle(root);
  const x = Math.max(
    box.left + parseFloat(style.paddingLeft) + 1,
    Math.min(event.clientX, box.right - parseFloat(style.paddingRight) - 1),
  );
  const at = document.caretPositionFromPoint
    ? document.caretPositionFromPoint(x, event.clientY)
    : null;
  const found = at
    ? [at.offsetNode, at.offset]
    : (() => {
        const given =
          document.caretRangeFromPoint && document.caretRangeFromPoint(x, event.clientY);
        return given && [given.startContainer, given.startOffset];
      })();
  root.focus({ preventScroll: true });
  if (found && root.contains(found[0])) place(found[0], found[1]);
};

// The caret never stands before a to-do's checkbox, where what is typed would come before it.
// Past the space after it, too, which is where the words of a to-do begin.
const keepOffCheckbox = () => {
  const at = range();
  if (!at || !at.collapsed) return;
  const item = elementOf(at.startContainer).closest('li');
  const held = item && root.contains(item) && checkboxOf(item);
  if (!held) return;
  const after = document.createRange();
  const space = held.nextSibling;
  if (space && space.nodeType === 3 && /^[ \u00a0]/.test(space.data)) after.setStart(space, 1);
  else after.setStartAfter(held);
  if (
    item.contains(at.startContainer) &&
    at.compareBoundaryPoints(Range.START_TO_START, after) < 0
  ) {
    place(after.startContainer, after.startOffset);
  }
};
`;

/**
 * What the editing frame of a Markdown document runs, in place of drawing it (EDITORS in
 * edit-frame.ts).
 */
export const DOCUMENT_EDITOR =
  MARKDOWN + CORE + DOCUMENT_BLOCKS + DOCUMENT_MARKS + DOCUMENT_MENUS + DOCUMENT_CLIPBOARD;
