/**
 * A Markdown document edited by hand, as script for the frame's page kept as text:
 * `const markdownOf = (root) => …`, which writes what `root` holds back as Markdown.
 *
 * The document is drawn as it always is (marked) and written in as one surface
 * (document-editor.ts); what is saved is this, read from the edited page. What Markdown says
 * natively is written so: headings, paragraphs, emphasis, code, links, pictures, lists and to-dos,
 * quotes, tables, rules. Anything it cannot say (a colour, an alignment, an underline, a callout,
 * a tag it does not know) is kept as the HTML it is, which Markdown allows, so nothing the owner
 * did is lost on the way back. Whatever the editor makes reads back as the same page.
 *
 * No template literal inside: this file is one already.
 */
export const MARKDOWN = String.raw`
const markdownOf = (root) => {
  const INLINE = /^(A|ABBR|B|BR|CODE|DEL|EM|I|IMG|INPUT|KBD|MARK|S|SMALL|SPAN|STRIKE|STRONG|SUB|SUP|U)$/;
  const BLOCK = /^(BLOCKQUOTE|DIV|H[1-6]|HR|OL|P|PRE|TABLE|UL)$/;
  // What marked writes on each; any other attribute is something Markdown cannot say.
  const OWN = {
    A: ['href', 'title'], IMG: ['src', 'alt', 'title'], OL: ['start'], CODE: ['class'],
    TH: ['align'], TD: ['align'], INPUT: ['type', 'checked', 'disabled'],
  };
  // An empty style is what the browser leaves on a block typed into in the panel: it says nothing,
  // and kept it would turn a heading into HTML.
  const plain = (node) =>
    [...node.attributes].every(
      (a) => (OWN[node.tagName] || []).includes(a.name) || (a.name === 'style' && !a.value.trim()),
    );
  const escape = (text) => text.replace(/[\\\x60*_[\]<~]/g, '\\$&');
  const lead = (text) => text.replace(/^([#>+-])/, '\\$1').replace(/^(\d+)([.)])/, '$1\\$2');
  const longest = (text, char) => Math.max(0, ...(text.match(new RegExp(char + '+', 'g')) || []).map((run) => run.length));
  // A mark hugs its words: Markdown does not read one standing next to a space.
  const wrap = (mark, text) => {
    const [, before, words, after] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
    return words ? before + mark + words + mark + after : text;
  };
  const address = (url) => (/[\s()<>]/.test(url) ? '<' + url.replace(/[<>]/g, encodeURIComponent) + '>' : url);
  const titled = (node) =>
    node.getAttribute('title') ? ' "' + node.getAttribute('title').replace(/"/g, '\\"') + '"' : '';
  // A break with nothing after it in its block is the one a browser leaves to hold an empty line
  // open. It shows nothing, and written out it would be a <br> in the Markdown.
  const placeholder = (node) => {
    for (let at = node; at.parentElement; at = at.parentElement) {
      for (let next = at.nextSibling; next; next = next.nextSibling) {
        if (next.nodeType === 3 ? next.data.trim() : next.nodeType === 1 && !/^(UL|OL)$/.test(next.tagName)) return false;
      }
      if (!INLINE.test(at.parentElement.tagName)) return true;
    }
    return true;
  };
  // HTML kept as it is ends at a blank line in Markdown, so a blank line inside it (in code) is
  // written as a character reference instead, which reads the same.
  const kept = (node) => node.outerHTML.replace(/\n(?=[ \t]*\n)/g, '&#10;');
  const preText = (node) =>
    [...node.childNodes].map((child) =>
      child.nodeType === 3 ? child.data : child.nodeName === 'BR' ? '\n' : child.nodeType === 1 ? preText(child) : '',
    ).join('');
  const code = (text) => {
    const fence = '\x60'.repeat(longest(text, '\x60') + 1);
    const pad = /^\x60|\x60$/.test(text) ? ' ' : '';
    return fence + pad + text + pad + fence;
  };

  const inline = (node) => [...node.childNodes].map(inlineOf).join('');
  const inlineOf = (node) => {
    if (node.nodeType === 3) return escape(node.data.replace(/\s+/g, ' '));
    if (node.nodeType !== 1) return '';
    if (!plain(node)) return node.outerHTML;
    switch (node.tagName) {
      case 'STRONG': case 'B': return wrap('**', inline(node));
      case 'EM': case 'I': return wrap('*', inline(node));
      case 'DEL': case 'S': case 'STRIKE': return wrap('~~', inline(node));
      case 'CODE': return code(node.textContent);
      case 'A': return '[' + inline(node) + '](' + address(node.getAttribute('href') || '') + titled(node) + ')';
      case 'IMG':
        return '![' + escape(node.getAttribute('alt') || '') + '](' + address(node.getAttribute('src') || '') + titled(node) + ')';
      case 'INPUT':
        return node.type === 'checkbox' ? (node.hasAttribute('checked') ? '[x]' : '[ ]') : node.outerHTML;
      // A break inside a heading or a table's cell is only said in HTML.
      case 'BR': return placeholder(node) ? '' : '<br>';
      default: return node.outerHTML;
    }
  };

  // The inline run between two blocks is a paragraph of its own.
  const blocks = (node, between = '\n\n') => {
    const made = [];
    let run = [];
    const flush = () => {
      const text = run.map(inlineOf).join('').trim();
      if (text) made.push(lead(text));
      run = [];
    };
    for (const child of node.childNodes) {
      if (child.nodeType === 3 || (child.nodeType === 1 && !BLOCK.test(child.tagName))) {
        run.push(child);
        continue;
      }
      flush();
      const block = blockOf(child);
      if (block) made.push(block);
    }
    flush();
    return made.join(between);
  };
  const indent = (text, pad) => text.split('\n').map((line, i) => (i && line ? pad + line : line)).join('\n');
  const list = (node) => {
    let n = Number(node.getAttribute('start')) || 1;
    return [...node.children]
      .filter((item) => item.tagName === 'LI')
      .map((item) => {
        const mark = node.tagName === 'OL' ? n++ + '. ' : '- ';
        // A list whose items hold paragraphs is a loose one, and stays so.
        let body = blocks(item, item.querySelector(':scope > p') ? '\n\n' : '\n');
        // A to-do's box is followed by one space, and an empty to-do still holds a character:
        // \x60- [ ]\x60 alone is read as the text "[ ]".
        const first = [...item.childNodes].find((child) => child.nodeType !== 3 || child.data.trim());
        if (first && first.nodeName === 'INPUT' && first.type === 'checkbox') {
          body = body.replace(/^(\[[ x]\])[ \t]*(\n|$)/, '$1 &nbsp;$2').replace(/^(\[[ x]\])[ \t]*(?=\S)/, '$1 ');
        }
        return mark + indent(body, ' '.repeat(mark.length));
      })
      .join('\n');
  };
  const table = (node) => {
    const rows = [...node.querySelectorAll('tr')];
    const cells = rows.map((row) => [...row.children]);
    const fits = rows.length && cells.flat().every((cell) => plain(cell) && ![...cell.querySelectorAll('*')].some((inner) => BLOCK.test(inner.tagName) || inner.tagName === 'LI'));
    if (!fits || node.querySelector('table')) return kept(node);
    const width = Math.max(...cells.map((row) => row.length));
    const line = (row) =>
      '| ' + Array.from({ length: width }, (_, i) => row[i] || '').join(' | ') + ' |';
    const ALIGN = { left: ':--', center: ':-:', right: '--:' };
    const written = cells.map((row) => row.map((cell) => inline(cell).trim().replace(/\|/g, '\\|')));
    const align = Array.from({ length: width }, (_, i) => ALIGN[cells[0][i] && cells[0][i].getAttribute('align')] || '---');
    return [line(written[0]), line(align), ...written.slice(1).map(line)].join('\n');
  };
  const blockOf = (node) => {
    if (!plain(node)) return kept(node);
    const tag = node.tagName;
    if (/^H[1-6]$/.test(tag)) {
      const words = inline(node).trim();
      return words && '#'.repeat(Number(tag[1])) + ' ' + words;
    }
    switch (tag) {
      case 'P': return lead(inline(node).trim());
      case 'DIV': return blocks(node);
      case 'HR': return '---';
      case 'UL': case 'OL': return list(node);
      case 'TABLE': return table(node);
      case 'BLOCKQUOTE':
        return blocks(node).split('\n').map((line) => (line ? '> ' + line : '>')).join('\n');
      case 'PRE': {
        const inner = node.querySelector('code');
        const text = preText(inner || node).replace(/\n$/, '');
        const language = inner && /language-(\S+)/.exec(inner.className);
        const fence = '\x60'.repeat(Math.max(3, longest(text, '\x60') + 1));
        return fence + (language ? language[1] : '') + '\n' + text + '\n' + fence;
      }
      default: return kept(node);
    }
  };

  return blocks(root).trim() + '\n';
};
`;
