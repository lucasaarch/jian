/**
 * What floats over the document while it is written (document-editor.ts, whose scope this runs
 * in): the menu of blocks a `/` opens, the bar of formatting over a selection with its field for
 * a link, and the handle beside the block under the pointer, which adds a block below it or drags
 * it elsewhere.
 *
 * They hang off the page beside the root, never in it, and carry `data-jian-edit`, so nothing of
 * them is ever saved. A press on any of them keeps the selection where it was in the text.
 *
 * No template literal inside: this file is one already.
 */
export const DOCUMENT_MENUS = String.raw`
const icon = (path) =>
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"' +
  ' stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="' +
  path +
  '"/></svg>';
const BLOCKS = [
  ['p', 'Text', '', 'paragraph plain', icon('M5 7V5h14v2M12 5v14M9 19h6')],
  ['h1', 'Heading 1', '#', 'title big h1', 'H1'],
  ['h2', 'Heading 2', '##', 'subtitle medium h2', 'H2'],
  ['h3', 'Heading 3', '###', 'small h3', 'H3'],
  [
    'ul',
    'Bulleted list',
    '-',
    'bullet unordered ul',
    icon('M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01'),
  ],
  [
    'ol',
    'Numbered list',
    '1.',
    'number ordered ol',
    icon('M10 6h10M10 12h10M10 18h10M4 5l1-1v4M3.5 14h2l-2 3.5h2'),
  ],
  [
    'todo',
    'To-do list',
    '[]',
    'task check checkbox todo',
    icon('M4 4h6v6H4zM4 16l2 2 4-4M14 7h6M14 17h6'),
  ],
  [
    'quote',
    'Quote',
    '>',
    'blockquote citation',
    icon('M6 18c2-1 3-3 3-6V7H5v5h4M16 18c2-1 3-3 3-6V7h-4v5h4'),
  ],
  [
    'code',
    'Code block',
    '\x60\x60\x60',
    'snippet pre program',
    icon('M8 8l-4 4 4 4M16 8l4 4-4 4M14 5l-4 14'),
  ],
  ['hr', 'Divider', '---', 'separator rule line hr', icon('M4 12h16')],
  ['table', 'Table', '', 'grid rows columns', icon('M4 5h16v14H4zM4 10h16M4 15h16M10 5v14')],
  [
    'callout',
    'Callout',
    '',
    'note info tip aside box',
    icon('M4 5h16v14H4zM8 10h.01M11 10h5M8 14h8'),
  ],
];

let slash = null;
let slashMenu;
let bar;
let address;
let unlinkButton;
let linking = null;
let handle;
let drop;
let hovered = null;
let dragging = null;
let pressing = false;

const build = () => {
  slashMenu = make('div', {
    id: 'jian-slash',
    class: 'jian-pop',
    role: 'listbox',
    'aria-label': 'Blocks',
    'data-jian-edit': '',
  });
  slashMenu.hidden = true;
  slashMenu.addEventListener('mousedown', (event) => {
    event.preventDefault();
    const item = event.target.closest('[data-index]');
    if (item) choose(Number(item.getAttribute('data-index')));
  });
  slashMenu.addEventListener('mousemove', (event) => {
    const item = event.target.closest('[data-index]');
    if (item && slash && slash.index !== Number(item.getAttribute('data-index'))) {
      slash.index = Number(item.getAttribute('data-index'));
      drawSlash();
    }
  });

  const TOOLS = [
    ['bold', 'Bold', keyName('B'), '<b>B</b>'],
    ['italic', 'Italic', keyName('I'), '<i style="font-family: Georgia, serif">I</i>'],
    ['strike', 'Strikethrough', keyName('S', true), '<s>S</s>'],
    ['code', 'Inline code', keyName('E'), icon('M8 8l-4 4 4 4M16 8l4 4-4 4')],
    [
      'link',
      'Link',
      keyName('K'),
      icon(
        'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7',
      ),
    ],
    ['rule'],
    ['h1', 'Heading 1', keyName('1', false, true), 'H1'],
    ['h2', 'Heading 2', keyName('2', false, true), 'H2'],
    ['h3', 'Heading 3', keyName('3', false, true), 'H3'],
  ];
  bar = make('div', {
    id: 'jian-bar',
    class: 'jian-pop',
    role: 'toolbar',
    'aria-label': 'Text formatting',
    'data-jian-edit': '',
  });
  for (const [name, label, keys, glyph] of TOOLS) {
    if (name === 'rule') {
      bar.append(make('span', { class: 'rule', 'data-tools': '' }));
      continue;
    }
    bar.append(
      make(
        'button',
        {
          type: 'button',
          title: label + '  ' + keys,
          'aria-label': label,
          'aria-pressed': 'false',
          'data-tool': name,
          'data-tools': '',
        },
        glyph,
      ),
    );
  }
  address = make('input', {
    type: 'url',
    placeholder: 'Paste or type a link, then Enter',
    'aria-label': 'Link address',
    hidden: '',
  });
  unlinkButton = make(
    'button',
    { type: 'button', title: 'Remove link', 'aria-label': 'Remove link', hidden: '' },
    icon('M6 6l12 12M18 6L6 18'),
  );
  bar.append(address, unlinkButton);
  bar.hidden = true;
  bar.addEventListener('mousedown', (event) => {
    if (event.target !== address) event.preventDefault();
  });
  bar.addEventListener('click', (event) => {
    if (event.target.closest('button') === unlinkButton) return finishLink('');
    const button = event.target.closest('[data-tool]');
    if (!button) return;
    const tool = button.getAttribute('data-tool');
    if (tool === 'link') return startLink();
    if (MARKS[tool]) toggleMark(tool);
    else turnLines(tool);
    showBar();
  });
  address.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      finishLink(address.value.trim() || null);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      finishLink(null);
    }
  });
  address.addEventListener('blur', () => {
    if (linking) setTimeout(() => linking && document.activeElement !== address && endLink());
  });

  const dot = (x, y) => '<circle cx="' + x + '" cy="' + y + '" r="1.6"/>';
  handle = make(
    'div',
    { id: 'jian-handle', 'data-jian-edit': '' },
    '<button type="button" data-act="add" title="Add a block below" aria-label="Add a block below">' +
      icon('M12 5v14M5 12h14') +
      '</button>' +
      '<button type="button" data-act="drag" title="Drag to move" aria-label="Drag to move">' +
      '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">' +
      [6, 12, 18].map((y) => dot(9, y) + dot(15, y)).join('') +
      '</svg></button>',
  );
  handle.hidden = true;
  drop = make('div', { id: 'jian-drop', 'data-jian-edit': '' });
  drop.hidden = true;
  document.body.append(slashMenu, bar, handle, drop);

  handle.addEventListener('mousedown', (event) => event.preventDefault());
  handle.querySelector('[data-act=add]').addEventListener('click', addBelow);
  const grip = handle.querySelector('[data-act=drag]');
  grip.addEventListener('pointerdown', (event) => {
    if (!hovered) return;
    event.preventDefault();
    grip.setPointerCapture(event.pointerId);
    dragging = { block: hovered, y: event.clientY, moved: false, before: undefined };
  });
  grip.addEventListener('pointermove', dragMove);
  grip.addEventListener('pointerup', dragEnd);
  grip.addEventListener('pointercancel', () => dragEnd(null));

  document.addEventListener(
    'pointerdown',
    (event) => {
      if (!event.target.closest || !event.target.closest('[data-jian-edit]')) pressing = true;
    },
    true,
  );
  document.addEventListener(
    'pointerup',
    () => {
      pressing = false;
      setTimeout(follow);
    },
    true,
  );
  document.addEventListener('mousemove', hover);
  addEventListener(
    'scroll',
    () => {
      hideHandle();
      follow();
    },
    true,
  );
  addEventListener('resize', follow);
  root.addEventListener('blur', () =>
    setTimeout(() => {
      if (document.activeElement !== root && document.activeElement !== address) closeSlash();
    }),
  );
};

// Where the caret is on screen, for a menu opened at it.
const caretPlace = () => {
  const at = range();
  return at ? caretBox(at) : null;
};
const floatAt = (element, box, above) => {
  element.hidden = false;
  const width = element.offsetWidth;
  const height = element.offsetHeight;
  let top = above ? box.top - height - 8 : box.bottom + 6;
  if (above && top < 6) top = box.bottom + 8;
  if (!above && top + height > innerHeight - 6) top = Math.max(6, box.top - height - 6);
  const left = above ? box.left + box.width / 2 - width / 2 : box.left - 6;
  element.style.top = Math.round(top) + 'px';
  element.style.left = Math.round(Math.max(6, Math.min(left, innerWidth - width - 6))) + 'px';
};

// The menu of blocks. It reads what was typed after the slash, in the same text, as a filter,
// and goes away when the caret leaves that text or nothing has matched for a while.
const slashTyped = (node, at) => {
  if (at < 0 || node.data[at] !== '/') return;
  if (at > 0 && !/[\s\u00a0]/.test(node.data[at - 1])) return;
  slash = { node, at, index: 0, matches: BLOCKS, hit: 0 };
  drawSlash();
};
const slashQuery = () => {
  if (!slash || !slash.node.isConnected || slash.node.data[slash.at] !== '/') return null;
  const at = range();
  if (!at || !at.collapsed || at.startContainer !== slash.node || at.startOffset <= slash.at)
    return null;
  return slash.node.data.slice(slash.at + 1, at.startOffset);
};
const drawSlash = () => {
  if (!slash) return;
  const query = slashQuery();
  if (query === null || /^\s/.test(query)) return closeSlash();
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = BLOCKS.filter(([, label, keys, more]) =>
    words.every((word) => (label + ' ' + more + ' ' + keys).toLowerCase().includes(word)),
  );
  if (matches.length) slash.hit = query.length;
  else if (query.length - slash.hit > 3) return closeSlash();
  if (
    matches.length !== slash.matches.length ||
    matches.some((item, i) => item !== slash.matches[i])
  )
    slash.index = 0;
  slash.matches = matches;
  slashMenu.replaceChildren(make('div', { class: 'title' }, matches.length ? 'Blocks' : ''));
  if (!matches.length)
    slashMenu.firstChild.replaceWith(make('div', { class: 'none' }, 'No matching blocks'));
  matches.forEach(([, label, keys, , glyph], index) => {
    const item = make('div', {
      class: 'item',
      role: 'option',
      'data-index': String(index),
      'aria-selected': String(index === slash.index),
    });
    item.append(
      make('span', { class: 'icon' }, glyph),
      make('span', { class: 'label' }),
      make('span', { class: 'keys' }),
    );
    item.children[1].textContent = label;
    item.children[2].textContent = keys;
    slashMenu.append(item);
  });
  const box = caretPlace();
  if (box) floatAt(slashMenu, box, false);
  const chosen = slashMenu.querySelector('[aria-selected=true]');
  if (chosen) {
    const top = chosen.offsetTop;
    if (top < slashMenu.scrollTop) slashMenu.scrollTop = top - 6;
    else if (top + chosen.offsetHeight > slashMenu.scrollTop + slashMenu.clientHeight) {
      slashMenu.scrollTop = top + chosen.offsetHeight - slashMenu.clientHeight + 6;
    }
  }
};
const closeSlash = () => {
  slash = null;
  if (slashMenu) slashMenu.hidden = true;
};
const choose = (index) => {
  const query = slashQuery();
  const item = slash && slash.matches[index];
  const { node, at } = slash || {};
  closeSlash();
  if (query === null || !item) return;
  record();
  const block = blockOf(node);
  const cut = document.createRange();
  cut.setStart(node, at);
  cut.setEnd(node, at + 1 + query.length);
  cut.deleteContents();
  place(node, at);
  insertBlock(item[0], block);
  settle();
  mark();
};
// The keys the menu takes while it is open; the rest go on to the text.
const slashKey = (event) => {
  if (!slash || slashMenu.hidden) return false;
  const count = slash.matches.length;
  const take = () => {
    event.preventDefault();
    event.stopPropagation();
    return true;
  };
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    if (!count) return take();
    slash.index = (slash.index + (event.key === 'ArrowDown' ? 1 : count - 1)) % count;
    drawSlash();
    return take();
  }
  if ((event.key === 'Enter' || event.key === 'Tab') && count) {
    take();
    choose(slash.index);
    return true;
  }
  if (event.key === 'Escape') {
    closeSlash();
    return take();
  }
  return false;
};

// The bar of formatting, over any selection of words outside code.
const showBar = () => {
  if (linking) return;
  const at = range();
  const plain = (node) => {
    const block = blockOf(node);
    return block && block.tagName !== 'PRE';
  };
  if (
    !at ||
    at.collapsed ||
    pressing ||
    dragging ||
    !at.toString().trim() ||
    !(plain(at.startContainer) || plain(at.endContainer))
  ) {
    bar.hidden = true;
    return;
  }
  for (const button of bar.querySelectorAll('[data-tool]')) {
    const tool = button.getAttribute('data-tool');
    const on = MARKS[tool]
      ? Boolean(markOf(at.startContainer, tool))
      : tool === 'link'
        ? Boolean(elementOf(at.startContainer).closest('#root a'))
        : linesIn(at).every((line) => line.tagName === tool.toUpperCase());
    button.setAttribute('aria-pressed', String(on));
  }
  floatAt(bar, at.getBoundingClientRect(), true);
};
// A link is written in the bar's field. Taken from a selection, a link round the words; from a
// caret in a link, that link, which can then be changed or taken off.
const startLink = () => {
  const at = range();
  if (!at) return;
  const held = elementOf(at.startContainer).closest('a');
  const link = held && root.contains(held) ? held : null;
  linking = { range: at.cloneRange(), link };
  for (const tool of bar.querySelectorAll('[data-tools]')) tool.hidden = true;
  address.hidden = false;
  unlinkButton.hidden = !link;
  address.value = link ? link.getAttribute('href') || '' : '';
  floatAt(bar, at.collapsed ? caretBox(at) : at.getBoundingClientRect(), true);
  address.focus();
  address.select();
};
const endLink = () => {
  linking = null;
  for (const tool of bar.querySelectorAll('[data-tools]')) tool.hidden = false;
  address.hidden = true;
  unlinkButton.hidden = true;
  bar.hidden = true;
};
// Only an address that opens a page or writes a letter; never one that runs something.
const addressOf = (given) => (/^(https?:|mailto:|#)/i.test(given) ? given : 'https://' + given);
const finishLink = (given) => {
  const state = linking;
  endLink();
  if (!state) return;
  root.focus({ preventScroll: true });
  select(state.range);
  if (given === null) return showBar();
  record();
  if (state.link) {
    if (given) state.link.setAttribute('href', addressOf(given));
    else keeping(() => state.link.replaceWith(...state.link.childNodes));
  } else if (given && !state.range.collapsed) {
    document.execCommand('createLink', false, addressOf(given));
  } else if (given) {
    const link = make('a', { href: addressOf(given) });
    link.textContent = given;
    state.range.insertNode(link);
    stepOut(link);
  }
  settle();
  mark();
};

// The handle beside the block under the pointer, at the height of its first line.
const blockAt = (y) => {
  for (const block of root.children) {
    const box = block.getBoundingClientRect();
    const style = getComputedStyle(block);
    if (
      y >= box.top - parseFloat(style.marginTop) / 2 - 2 &&
      y <= box.bottom + parseFloat(style.marginBottom) / 2 + 2
    )
      return block;
  }
  return null;
};
const hover = (event) => {
  if (dragging || (event.target.closest && event.target.closest('#jian-handle'))) return;
  const box = root.getBoundingClientRect();
  const block =
    event.clientX >= box.left - 80 && event.clientX <= box.right ? blockAt(event.clientY) : null;
  if (!block) return hideHandle();
  const left = box.left + parseFloat(getComputedStyle(root).paddingLeft) - 50;
  if (left < 2) return hideHandle();
  hovered = block;
  const first = block.matches('ul, ol')
    ? block.querySelector('li') || block
    : block.tagName === 'TABLE'
      ? block.rows[0] || block
      : block;
  const edge = first.getBoundingClientRect();
  const style = getComputedStyle(first);
  const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.3 || 24;
  const top =
    block.tagName === 'HR'
      ? edge.top + edge.height / 2 - 12
      : block.tagName === 'TABLE'
        ? edge.top + Math.min(edge.height, 44) / 2 - 12
        : edge.top + (parseFloat(style.paddingTop) || 0) + (line - 24) / 2;
  handle.style.left = Math.round(left + scrollX) + 'px';
  handle.style.top = Math.round(top + scrollY) + 'px';
  handle.hidden = false;
};
const hideHandle = () => {
  if (dragging || !handle) return;
  handle.hidden = true;
  hovered = null;
};
// The + adds a line below the block, or takes the one it is beside if that line is empty, and
// opens the menu of blocks there.
const addBelow = () => {
  const block = hovered;
  if (!block) return;
  record();
  let line = block;
  if (!(paragraph(block) && isEmpty(block))) {
    line = make('p');
    block.after(line);
  }
  const typedSlash = document.createTextNode('/');
  line.replaceChildren(typedSlash);
  root.focus({ preventScroll: true });
  place(typedSlash, 1);
  hideHandle();
  slashTyped(typedSlash, 0);
  hints();
  mark();
};
const dragMove = (event) => {
  if (!dragging) return;
  if (!dragging.moved && Math.abs(event.clientY - dragging.y) < 4) return;
  dragging.moved = true;
  dragging.block.setAttribute('data-jian-dragging', '');
  bar.hidden = true;
  if (event.clientY < 40) scrollBy(0, -12);
  else if (event.clientY > innerHeight - 40) scrollBy(0, 12);
  const others = [...root.children].filter((block) => block !== dragging.block);
  const before =
    others.find((block) => {
      const box = block.getBoundingClientRect();
      return event.clientY < box.top + box.height / 2;
    }) || null;
  dragging.before = before;
  const box = root.getBoundingClientRect();
  const style = getComputedStyle(root);
  const last = others[others.length - 1];
  const y = before
    ? before.getBoundingClientRect().top - 6
    : last
      ? last.getBoundingClientRect().bottom + 4
      : box.top;
  drop.style.left = Math.round(box.left + parseFloat(style.paddingLeft) + scrollX) + 'px';
  drop.style.width =
    Math.round(box.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)) + 'px';
  drop.style.top = Math.round(y + scrollY) + 'px';
  drop.hidden = false;
};
const dragEnd = (event) => {
  const state = dragging;
  dragging = null;
  drop.hidden = true;
  if (!state) return;
  state.block.removeAttribute('data-jian-dragging');
  if (!event) return;
  if (!state.moved) {
    // A press on the handle with no drag selects the block's words.
    root.focus({ preventScroll: true });
    const all = document.createRange();
    all.selectNodeContents(state.block);
    select(all);
    return;
  }
  if (state.before === state.block.nextElementSibling) return;
  record();
  keeping(() => root.insertBefore(state.block, state.before));
  settle();
  mark();
};

// Called after anything that moves the caret or changes the page.
const follow = () => {
  if (!bar) return;
  if (slash) drawSlash();
  showBar();
};
const closeAll = () => {
  closeSlash();
  if (linking) finishLink(null);
  else if (bar) bar.hidden = true;
};
`;
