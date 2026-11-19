import { ARTIFACT_EDIT_MESSAGE, type SessionArtifactType } from '@jian/contracts';
import { MARKDOWN } from './markdown-frame.js';
import { SHEET } from './sheet-frame.js';
import { SLIDE_BUILDER } from './slide-builder.js';

/**
 * What the frame runs in place of drawing when the owner edits a page or a slide by hand. It is
 * script for the frame's page, kept as text: `const editPage = (source, options, finish, build) => …`.
 * `finish`, when given, is what the edited page is saved as instead of its markup (a
 * document's Markdown). `build`, when given, adds to the editor before it hears anything: a deck's
 * slide is built on as well as typed in (slide-builder.ts).
 *
 * - The source is read as a document and never run. A page's own scripts are left exactly as
 *   written and stay asleep, so what is saved is the page the agent wrote plus the owner's
 *   edits, not whatever its scripts drew at that moment. While it is edited the frame therefore
 *   holds no script but this one, and a `meta refresh`, which would navigate it, is dropped.
 * - A click on text makes the block holding it editable, with a small bar of formatting over it.
 *   A list is edited whole, so Enter gives a new item; anywhere else Enter breaks the line, since
 *   a block inside a paragraph or a heading would not survive being read as HTML again.
 * - It answers its parent only when asked (`collect`), and only with the markup: everything this
 *   script added, marked `data-jian-edit` or `data-jian-editing`, is taken out first.
 *
 * It reaches nothing: the frame's policy still refuses every request, and the one thing sent
 * out is that answer to the panel, which decides what to do with it.
 */
const STYLE = `
[data-jian-editing] { outline: 2px solid #4c8dff !important; outline-offset: 2px; cursor: text; }
#jian-edit-bar { all: initial; position: fixed; z-index: 2147483647; display: flex;
  flex-wrap: wrap; align-items: center; gap: 2px; width: max-content; max-width: 320px;
  padding: 4px; border-radius: 10px; background: rgba(28, 28, 30, .94); color: #fff;
  box-shadow: 0 6px 24px rgba(0, 0, 0, .35); font: 13px/1 system-ui, -apple-system, "Segoe UI",
  sans-serif; transform-origin: 0 0; user-select: none; -webkit-user-select: none; }
#jian-edit-bar[hidden], #jian-edit-bar [hidden] { display: none; }
#jian-edit-bar button { all: unset; display: grid; place-items: center; width: 28px;
  height: 28px; border-radius: 6px; cursor: pointer; color: inherit; font: inherit; }
#jian-edit-bar button:hover { background: rgba(255, 255, 255, .16); }
#jian-edit-bar button:disabled { opacity: .35; cursor: default; background: none; }
#jian-edit-bar .row { display: flex; flex-basis: 100%; gap: 6px; padding: 4px 4px 2px; }
#jian-edit-bar input { all: unset; flex: 1; min-width: 0; height: 26px; padding: 0 8px;
  border-radius: 6px; background: rgba(255, 255, 255, .14); color: #fff; font: inherit;
  cursor: text; }
#jian-edit-bar .swatch { width: 20px; height: 20px; border-radius: 999px;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .45); }
`;

const EDITING = String.raw`
const editPage = (source, options, finish, build) => {
  const KEY = ${JSON.stringify(ARTIFACT_EDIT_MESSAGE)};
  const parsed = new DOMParser().parseFromString(source, 'text/html');
  const doctype = parsed.doctype ? '<!doctype html>\n' : '';
  // With no script awake, a page that sends its reader elsewhere is all that could still take
  // this frame somewhere. It goes, and is not in what is saved.
  for (const meta of parsed.querySelectorAll('meta[http-equiv="refresh" i]')) meta.remove();
  document.replaceChild(document.adoptNode(parsed.documentElement), document.documentElement);

  let scale = 1;
  let changed = false;
  // Tells the panel something changed, never what: it asks for the page when it wants to save.
  const mark = () => {
    changed = true;
    parent.postMessage({ [KEY]: { changed: true } }, '*');
  };
  let active = null;
  let saved = null;

  const make = (tag, attributes, html) => {
    const node = document.createElement(tag);
    for (const name in attributes) node.setAttribute(name, attributes[name]);
    if (html) node.innerHTML = html;
    return node;
  };
  const icon = (path) =>
    '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"' +
    ' stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="' + path + '"/></svg>';
  const TOOLS = [
    ['bold', 'Bold', '<b>B</b>'],
    ['italic', 'Italic', '<i>I</i>'],
    ['underline', 'Underline', '<u>U</u>'],
    ['link', 'Link', icon('M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7')],
    ['insertUnorderedList', 'Bulleted list', icon('M9 6h12M9 12h12M9 18h12M4 6h.01M4 12h.01M4 18h.01')],
    ['insertOrderedList', 'Numbered list', icon('M10 6h11M10 12h11M10 18h11M3.5 5l1-1v4M3 14h2l-2 3.5h2')],
    ['alignLeft', 'Align left', icon('M3 6h18M3 12h12M3 18h15')],
    ['alignCenter', 'Align center', icon('M3 6h18M6 12h12M4.5 18h15')],
    ['alignRight', 'Align right', icon('M3 6h18M9 12h12M6 18h15')],
    ['color', 'Text color', '<span style="padding:0 2px;border-bottom:2px solid #ff5a52">A</span>'],
  ];
  const COLORS = ['#111111', '#ffffff', '#6b7280', '#e5484d', '#f59e0b', '#30a46c', '#3b82f6', '#8b5cf6'];

  const style = make('style', { 'data-jian-edit': '' });
  style.textContent = ${JSON.stringify(STYLE)};
  const bar = make('div', {
    id: 'jian-edit-bar',
    'data-jian-edit': '',
    role: 'toolbar',
    'aria-label': 'Text formatting',
  });
  bar.hidden = true;
  const buttons = {};
  for (const [name, label, glyph] of TOOLS) {
    buttons[name] = make('button', { type: 'button', title: label, 'aria-label': label, 'data-tool': name }, glyph);
    bar.append(buttons[name]);
  }
  const linkRow = make('div', { class: 'row' });
  const address = make('input', { type: 'url', placeholder: 'Address, then Enter', 'aria-label': 'Link address' });
  linkRow.append(address);
  const colorRow = make('div', { class: 'row' });
  for (const color of COLORS) {
    const swatch = make('button', { type: 'button', class: 'swatch', title: color, 'aria-label': 'Color ' + color, 'data-color': color });
    swatch.style.background = color;
    colorRow.append(swatch);
  }
  linkRow.hidden = true;
  colorRow.hidden = true;
  bar.append(linkRow, colorRow);
  document.head.append(style);
  // Beside the body, not in it: what the page lays out and counts stays as it was written.
  document.documentElement.append(bar);

  const SKIP = 'svg, canvas, video, audio, iframe, object, embed, select, textarea, input, script, style, [data-jian-edit]';
  const elementOf = (node) => (node && node.nodeType !== 1 ? node.parentElement : node);
  const inline = (node) => getComputedStyle(node).display === 'inline';
  const texty = (node) =>
    [...node.childNodes].some((child) =>
      child.nodeType === 3
        ? child.data.trim() !== ''
        : child.nodeType === 1 && !child.matches(SKIP) && inline(child) && texty(child),
    );
  // The block that holds the text under the pointer; nothing for a box with no text of its own.
  const hostOf = (target) => {
    let node = elementOf(target);
    if (!node || node === document.documentElement || node.closest(SKIP) || !texty(node)) return null;
    while (node !== document.body && inline(node) && node.parentElement) node = node.parentElement;
    if (node.tagName === 'LI') node = node.closest('ul, ol') || node;
    return node;
  };

  const place = () => {
    if (!active) return;
    bar.hidden = false;
    // A list in a paragraph is not HTML, and a list is not turned into something else from inside.
    buttons.insertUnorderedList.disabled = buttons.insertOrderedList.disabled = /^(P|UL|OL)$/.test(active.tagName);
    const k = 1 / scale;
    bar.style.transform = 'scale(' + k + ')';
    const box = active.getBoundingClientRect();
    const width = bar.offsetWidth * k;
    const height = bar.offsetHeight * k;
    const gap = 8 * k;
    let top = box.top - height - gap;
    if (top < 4) top = Math.min(box.bottom + gap, innerHeight - height - 4);
    bar.style.top = Math.max(4, top) + 'px';
    bar.style.left = Math.max(4, Math.min(box.left, innerWidth - width - 4)) + 'px';
  };
  const release = () => {
    if (!active) return;
    active.removeAttribute('contenteditable');
    active.removeAttribute('data-jian-editing');
    active = null;
    saved = null;
    bar.hidden = true;
    linkRow.hidden = true;
    colorRow.hidden = true;
  };
  const select = (range) => {
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  };
  const caret = (x, y) => {
    if (document.caretPositionFromPoint) {
      const at = document.caretPositionFromPoint(x, y);
      if (!at) return null;
      const range = document.createRange();
      range.setStart(at.offsetNode, at.offset);
      return range;
    }
    return document.caretRangeFromPoint ? document.caretRangeFromPoint(x, y) : null;
  };
  const act = (name, value) => {
    active.focus();
    document.execCommand(name, false, value);
    mark();
    place();
  };

  // Before the editor's own listeners, so what it handles first never reaches them.
  if (build) build({ KEY, mark, release, active: () => active, options: options || {} });

  addEventListener('click', (event) => {
    if (bar.contains(event.target)) return;
    // No link is followed, and nothing the page tied to a click runs, while it is edited.
    event.preventDefault();
    event.stopPropagation();
    const host = hostOf(event.target);
    if (host === active) return;
    release();
    if (!host) return;
    active = host;
    host.setAttribute('contenteditable', 'true');
    host.setAttribute('data-jian-editing', '');
    host.focus();
    const range = caret(event.clientX, event.clientY);
    if (range && host.contains(range.startContainer)) select(range);
    place();
  }, true);

  addEventListener('keydown', (event) => {
    if (!active || bar.contains(event.target)) return;
    if (event.key === 'Escape') return release();
    if (event.key !== 'Enter' || event.shiftKey) return;
    const item = (elementOf(getSelection().anchorNode) || active).closest('li');
    if (item && item !== active && active.contains(item)) return;
    event.preventDefault();
    document.execCommand('insertLineBreak');
    mark();
  }, true);

  // Pasted as words alone: markup from elsewhere would bring styles and addresses with it.
  addEventListener('paste', (event) => {
    if (!active || bar.contains(event.target)) return;
    event.preventDefault();
    document.execCommand('insertText', false, event.clipboardData.getData('text/plain'));
    mark();
  }, true);
  addEventListener('drop', (event) => event.preventDefault(), true);
  addEventListener('input', (event) => {
    if (bar.contains(event.target)) return;
    mark();
    place();
  }, true);
  addEventListener('scroll', place, true);
  addEventListener('resize', place);

  // A press on the bar must not take the selection out of the text it is about to change.
  bar.addEventListener('mousedown', (event) => {
    if (event.target !== address) event.preventDefault();
  });
  bar.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button || button.disabled || !active) return;
    const color = button.getAttribute('data-color');
    const tool = button.getAttribute('data-tool');
    if (color) {
      document.execCommand('styleWithCSS', false, true);
      act('foreColor', color);
      document.execCommand('styleWithCSS', false, false);
      colorRow.hidden = true;
    } else if (tool === 'color') {
      colorRow.hidden = !colorRow.hidden;
      linkRow.hidden = true;
    } else if (tool === 'link') {
      const selection = getSelection();
      const linked = (elementOf(selection.anchorNode) || active).closest('a');
      if (linked && linked !== active && active.contains(linked)) {
        const whole = document.createRange();
        whole.selectNodeContents(linked);
        select(whole);
        return act('unlink');
      }
      saved = selection.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
      colorRow.hidden = true;
      linkRow.hidden = !linkRow.hidden;
      if (!linkRow.hidden) {
        address.value = '';
        address.focus();
      }
    } else if (tool.startsWith('align')) {
      // Set on the block itself. The browser's own command wraps the text in a block of its
      // own, which a paragraph cannot hold and which costs a heading its size.
      active.style.textAlign = tool.slice(5).toLowerCase();
      mark();
    } else {
      act(tool);
    }
    place();
  });
  address.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== 'Escape') return;
    event.preventDefault();
    const given = address.value.trim();
    linkRow.hidden = true;
    active.focus();
    if (saved) select(saved);
    if (event.key === 'Enter' && given) {
      // Only an address that opens a page or writes a letter; never one that runs something.
      const url = /^(https?:|mailto:)/i.test(given) ? given : 'https://' + given;
      const text = (value) => value.replace(/[&<>"]/g, (char) => '&#' + char.charCodeAt(0) + ';');
      if (getSelection().isCollapsed) act('insertHTML', '<a href="' + text(url) + '">' + text(url) + '</a>');
      else act('createLink', url);
    }
    place();
  });

  // The page as it now stands, with nothing of this script left in it.
  const markup = () => {
    const copy = document.documentElement.cloneNode(true);
    for (const node of copy.querySelectorAll('[data-jian-edit]')) node.remove();
    for (const node of copy.querySelectorAll('[data-jian-editing]')) {
      node.removeAttribute('contenteditable');
      node.removeAttribute('data-jian-editing');
    }
    return finish ? finish(copy) : doctype + copy.outerHTML;
  };
  const told = (ask) => {
    if (!ask) return;
    if (typeof ask.scale === 'number' && ask.scale > 0) {
      scale = ask.scale;
      place();
    }
    if (typeof ask.collect !== 'string') return;
    const answer = changed ? { html: markup() } : { unchanged: true };
    parent.postMessage({ [KEY]: { collect: ask.collect, ...answer } }, '*');
  };
  told(options);
  addEventListener('message', (event) => {
    if (event.source === parent && event.data) told(event.data[KEY]);
  });
};
`;

/**
 * How a type drawn by a script of ours (sheet-frame.ts) answers: `made` is what
 * that script returned editable, `{ now, changed }`. As for a page, only when asked, and only
 * the source; a scale is nothing to it, being drawn at the frame's own size.
 */
const ANSWERING = `
const answering = (options, made) => {
  const KEY = ${JSON.stringify(ARTIFACT_EDIT_MESSAGE)};
  const told = (ask) => {
    if (!ask || typeof ask.collect !== 'string') return;
    const answer = made.changed() ? { html: made.now() } : { unchanged: true };
    parent.postMessage({ [KEY]: { collect: ask.collect, ...answer } }, '*');
  };
  told(options);
  addEventListener('message', (event) => {
    if (event.source === parent && event.data) told(event.data[KEY]);
  });
  // These scripts hand back their source and have no event to hear, so a change is noticed by
  // looking: cheap, since it is a string of what is on screen.
  let last = made.now();
  setInterval(() => {
    const now = made.now();
    if (now === last) return;
    last = now;
    parent.postMessage({ [KEY]: { changed: true } }, '*');
  }, 400);
};
`;

/**
 * A document is drawn as it always is and edited as a page is, inside the frame's own head (its
 * style); what is saved is its Markdown again. `run` and `read` are the frame page's.
 */
const MARKDOWN_EDITING = `
const editing = (source, options) => {
  run(read('libraries')[0]);
  const page = '<!doctype html><html lang="en">' + document.head.outerHTML +
    '<body class="markdown"><div id="root">' + marked.parse(source) + '</div></body></html>';
  editPage(page, options, (copy) => markdownOf(copy.querySelector('#root')));
};
`;

/**
 * What the editing frame of each type runs: `const editing = (source, options) => …`, with the
 * frame page's `root`, `run` and `read` in reach. Only the types in `EDITABLE_ARTIFACT_TYPES`.
 */
export const EDITORS: Partial<Record<SessionArtifactType, string>> = {
  html: `${EDITING}const editing = editPage;\n`,
  deck: `${EDITING}${SLIDE_BUILDER}const editing = (source, options) => editPage(source, options, null, buildSlide);\n`,
  markdown: EDITING + MARKDOWN + MARKDOWN_EDITING,
  sheet: `${SHEET}${ANSWERING}const editing = (source, options) => answering(options, sheet(source, root, true));\n`,
};
