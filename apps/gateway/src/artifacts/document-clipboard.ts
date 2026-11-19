/**
 * The document editor's clipboard (document-editor.ts, whose scope this runs in).
 *
 * What comes in is cut down to what Markdown holds: paragraphs, headings, lists, quotes, code,
 * tables, rules, emphasis, links and pictures. Fonts, colours, sizes, classes and every other
 * attribute stay behind, and so does anything that runs or loads (a script, a frame, a link that
 * runs code). A bold or an italic written as a style, as office suites and web pages write it, is
 * kept as the mark it shows. Plain text that reads as Markdown is read as Markdown.
 *
 * What goes out is the selection as HTML for an editor that reads it, and as plain text: its
 * Markdown when it spans several blocks, the words as they read when it is inside one.
 *
 * No template literal inside: this file is one already.
 */
export const DOCUMENT_CLIPBOARD = String.raw`
const tags = (names) => new Set(names.join(' ').split(' '));
// What is left out with all it holds: it runs, loads, or is no part of the words.
const DROPPED = tags([
  'SCRIPT STYLE META LINK TITLE TEMPLATE IFRAME FRAME OBJECT EMBED SVG CANVAS NOSCRIPT HEAD',
  'BUTTON SELECT TEXTAREA VIDEO AUDIO MATH CAPTION COLGROUP COL',
]);
// A box around blocks or a line: it goes, and what it held is a block of its own.
const WRAPPERS = tags([
  'DIV SECTION ARTICLE MAIN HEADER FOOTER ASIDE FIGURE FIGCAPTION NAV BODY HTML CENTER',
  'DL DD DT DETAILS SUMMARY FORM FIELDSET ADDRESS',
]);
const SAME = /^(P|H[1-6]|UL|LI|BLOCKQUOTE|HR|BR|TABLE|THEAD|TBODY|TFOOT|TR|TH|TD)$/;
const isBlock = (node) =>
  node.nodeType === 1 && /^(P|H[1-6]|UL|OL|LI|BLOCKQUOTE|PRE|HR|TABLE)$/.test(node.tagName);
const textWithBreaks = (node) =>
  [...node.childNodes]
    .map((child) =>
      child.nodeType === 3
        ? child.data
        : child.nodeName === 'BR'
          ? '\n'
          : child.nodeType === 1
            ? textWithBreaks(child)
            : '',
    )
    .join('');

// Inline runs between blocks made paragraphs, items standing alone put in a list, and blank
// runs dropped.
const blocksFrom = (nodes) => {
  const made = [];
  const lone = new Set();
  let run = [];
  const flush = () => {
    if (run.some((node) => node.nodeType === 1 || node.data.trim())) {
      const line = make('p');
      line.append(...run);
      made.push(line);
    }
    run = [];
  };
  for (const node of nodes) {
    if (!isBlock(node)) {
      run.push(node);
      continue;
    }
    flush();
    if (node.tagName === 'LI') {
      let list = made[made.length - 1];
      if (!lone.has(list)) {
        list = make('ul');
        lone.add(list);
        made.push(list);
      }
      list.append(node);
      continue;
    }
    made.push(node);
  }
  flush();
  return made;
};
const convert = (node) => {
  if (node.nodeType === 3) return [document.createTextNode(node.data.replace(/[\s\u00a0]+/g, ' '))];
  if (node.nodeType !== 1 || DROPPED.has(node.tagName)) return [];
  const tag = node.tagName;
  const style = (node.getAttribute('style') || '').toLowerCase();
  const inner = () => [...node.childNodes].flatMap(convert);
  const wrap = (name, attributes, children) => {
    const made = make(name, attributes);
    made.append(...(children || inner()));
    return [made];
  };
  if (tag === 'B' || tag === 'STRONG') {
    return /font-weight\s*:\s*(normal|[1-4]00)/.test(style) ? inner() : wrap('strong');
  }
  if (tag === 'I' || tag === 'EM')
    return /font-style\s*:\s*normal/.test(style) ? inner() : wrap('em');
  if (tag === 'S' || tag === 'DEL' || tag === 'STRIKE') return wrap('del');
  if (/^(CODE|KBD|SAMP|TT)$/.test(tag)) {
    const code = make('code');
    code.textContent = node.textContent;
    return [code];
  }
  if (tag === 'PRE') {
    const code = make('code');
    const held = node.querySelector('code') || node;
    const language = /(?:language|lang)-([\w+#.-]+)/.exec(held.className || '');
    if (language) code.className = 'language-' + language[1];
    code.textContent = textWithBreaks(node).replace(/\n?$/, '\n');
    return wrap('pre', {}, [code]);
  }
  if (tag === 'A') {
    const href = node.getAttribute('href') || '';
    return /^(https?:|mailto:)/i.test(href) ? wrap('a', { href }) : inner();
  }
  if (tag === 'IMG') {
    const src = node.getAttribute('src') || '';
    return /^(https?:|data:image\/)/i.test(src)
      ? [make('img', { src, alt: node.getAttribute('alt') || '' })]
      : [];
  }
  if (tag === 'INPUT') {
    return node.type === 'checkbox'
      ? [box(node.hasAttribute('checked')), document.createTextNode(GAP)]
      : [];
  }
  if (tag === 'OL') {
    const start = Number(node.getAttribute('start'));
    return wrap('ol', start > 1 ? { start: String(start) } : {});
  }
  if (tag === 'LI') {
    // An item that is one paragraph, as office suites write every item, is just its words.
    const kids = inner();
    const blocks = kids.filter(isBlock);
    if (
      blocks.length === 1 &&
      blocks[0].tagName === 'P' &&
      kids.every((kid) => kid === blocks[0] || (kid.nodeType === 3 && !kid.data.trim()))
    ) {
      return wrap('li', {}, [...blocks[0].childNodes]);
    }
    return wrap('li', {}, kids);
  }
  if (tag === 'TH' || tag === 'TD') {
    // A cell holds one line: Markdown has no paragraphs in a table.
    const words = inner().flatMap((kid) =>
      isBlock(kid) && !/^(UL|OL|TABLE)$/.test(kid.tagName)
        ? [...kid.childNodes, document.createTextNode(' ')]
        : [kid],
    );
    return wrap(tag.toLowerCase(), {}, words);
  }
  if (tag === 'BLOCKQUOTE') return wrap('blockquote', {}, blocksFrom(inner()));
  if (SAME.test(tag)) return wrap(tag.toLowerCase());
  if (WRAPPERS.has(tag)) {
    // Each box of its own is a line of its own, as it showed where it was copied from.
    return blocksFrom(inner());
  }
  // Anything else is taken for its words, with the marks its style shows.
  let made = inner();
  for (const [pattern, mark] of [
    [/font-weight\s*:\s*(bold|[6-9]00)/, 'strong'],
    [/font-style\s*:\s*italic/, 'em'],
    [/line-through/, 'del'],
  ]) {
    if (pattern.test(style)) made = wrap(mark, {}, made);
  }
  return made;
};
const cleanHtml = (html) => {
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  return blocksFrom(convert(parsed.body));
};
const MARKDOWNISH =
  /^(#{1,6} |[-*+] |\d{1,9}[.)] |> |\x60{3}|\|.*\|\s*$|---\s*$)|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\([^)\s]+\)/m;
const fromText = (text) => {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines.length === 1) return [Object.assign(make('p'), { textContent: text })];
  return lines
    .filter((line) => line.trim())
    .map((line) => Object.assign(make('p'), { textContent: line }));
};

// What was pasted put where the caret is. Words alone go in among the words there; blocks split
// the line at the caret, the first pasted paragraph joining what came before and the last what
// came after.
const put = (nodes, at) => {
  if (!nodes.length) return;
  const block = blockOf(at.startContainer);
  if (!block || (nodes.length === 1 && nodes[0].tagName === 'P')) {
    const words = nodes.length === 1 && nodes[0].tagName === 'P' ? [...nodes[0].childNodes] : nodes;
    const last = words[words.length - 1];
    const fragment = document.createDocumentFragment();
    fragment.append(...words);
    if (block && block.lastChild && block.lastChild.nodeName === 'BR' && isEmpty(block))
      block.lastChild.remove();
    at.insertNode(fragment);
    if (last.nodeType === 3) return place(last, last.length);
    const after = document.createRange();
    after.setStartAfter(last);
    return place(after.startContainer, after.startOffset);
  }
  if (block.tagName === 'LI') {
    const items = nodes.flatMap((node) => {
      if (LISTS.test(node.tagName)) return [...node.children];
      const item = make('li');
      if (node.tagName === 'LI') return [node];
      item.append(...(paragraph(node) || /^H[1-6]$/.test(node.tagName) ? node.childNodes : [node]));
      return [item];
    });
    if (isEmpty(block) && !checkboxOf(block)) block.replaceWith(...items);
    else block.after(...items);
    return placeIn(items[items.length - 1], true);
  }
  const tail = document.createRange();
  tail.setStart(at.startContainer, at.startOffset);
  tail.setEnd(block, block.childNodes.length);
  const after = block.cloneNode(false);
  after.append(tail.extractContents());
  if (block.lastChild && block.lastChild.nodeName === 'BR') block.lastChild.remove();
  let rest = nodes;
  if (rest[0].tagName === 'P') {
    block.append(...rest[0].childNodes);
    rest = rest.slice(1);
  }
  block.after(...rest);
  const last = rest.length ? rest[rest.length - 1] : block;
  const kept = after.textContent.replace(/[\s\u200b]/g, '') || after.querySelector('img');
  if (kept && (last === block || last.tagName === 'P' || /^H[1-6]$/.test(last.tagName))) {
    const pin = document.createTextNode('');
    last.append(pin, ...after.childNodes);
    place(pin, 0);
  } else {
    if (kept) last.after(after);
    placeIn(lastLine(last), true);
  }
  if (block !== last && isEmpty(block)) block.remove();
  else filled(block);
};
const paste = (event) => {
  event.preventDefault();
  const data = event.clipboardData;
  const at = range();
  if (!data || !at) return;
  const html = data.getData('text/html');
  const text = data.getData('text/plain');
  closeSlash();
  record();
  const block = blockOf(at.startContainer);
  if (block && (block.tagName === 'PRE' || elementOf(at.startContainer).closest('code'))) {
    insertPlain(text);
  } else if (block && /^T[HD]$/.test(block.tagName)) {
    insertPlain(text.replace(/\s*\n\s*/g, ' '));
  } else {
    const nodes = html
      ? cleanHtml(html)
      : MARKDOWNISH.test(text)
        ? cleanHtml(marked.parse(text))
        : fromText(text);
    if (!at.collapsed) document.execCommand('delete');
    const here = range();
    if (here) put(nodes, here);
  }
  settle();
  mark();
};

const copy = (event, cut) => {
  const at = range();
  if (!at || at.collapsed || !event.clipboardData) return;
  event.preventDefault();
  const holder = make('div');
  holder.append(at.cloneContents());
  // A piece of a list or a table comes out whole: its items in a list, its cells in a table.
  const common = elementOf(at.commonAncestorContainer);
  if (common && root.contains(common) && common !== root) {
    const outer = common.closest('ul, ol, table');
    if (
      outer &&
      root.contains(outer) &&
      [...holder.children].some((child) => /^(LI|TR|TD|TH|TBODY|THEAD)$/.test(child.tagName))
    ) {
      const whole = outer.cloneNode(false);
      if (
        whole.tagName === 'TABLE' &&
        [...holder.children].some((child) => /^T[HD]$/.test(child.tagName))
      ) {
        const row = make('tr');
        row.append(...holder.childNodes);
        whole.append(row);
      } else whole.append(...holder.childNodes);
      holder.append(whole);
    }
  }
  const clean = cleanCopy(holder);
  event.clipboardData.setData('text/html', clean.innerHTML);
  const one = blockOf(at.startContainer) === blockOf(at.endContainer);
  event.clipboardData.setData(
    'text/plain',
    one ? at.toString().replace(/\u200b/g, '') : markdownOf(clean).trim(),
  );
  if (cut) {
    record();
    document.execCommand('delete');
    settle();
    mark();
  }
};
`;
