/** What decides where a letter lands in a textarea, copied to the mirror that measures it. */
const MIRRORED = [
  'font-family',
  'font-size',
  'font-style',
  'font-weight',
  'font-variant',
  'letter-spacing',
  'line-height',
  'text-transform',
  'text-indent',
  'tab-size',
  'word-break',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
];

/**
 * Scrolls a textarea just enough to show its caret. The browser does that for what is typed,
 * but not when code writes the value and moves the caret, as a list continued with Shift+Enter
 * does: the field then stays where it was, with the caret out of sight below it.
 *
 * A textarea cannot say where its caret is, so the text before it is laid out again in a copy
 * as wide as the field's own text area, and the end of that copy is the caret.
 */
export function revealCaret(field: HTMLTextAreaElement) {
  if (field.scrollHeight <= field.clientHeight) return;
  const style = getComputedStyle(field);
  const mirror = document.createElement('div');
  for (const name of MIRRORED) mirror.style.setProperty(name, style.getPropertyValue(name));
  Object.assign(mirror.style, {
    position: 'absolute',
    visibility: 'hidden',
    left: '-9999px',
    top: '0',
    boxSizing: 'border-box',
    // The field's text area: its padding box, less any scrollbar.
    width: `${field.clientWidth}px`,
    whiteSpace: 'pre-wrap',
    overflowWrap: 'break-word',
  });
  mirror.textContent = field.value.slice(0, field.selectionEnd);
  // A zero-width mark, so a caret after a line break stands on the new line.
  const mark = document.createElement('span');
  mark.textContent = '\u200b';
  mirror.append(mark);
  document.body.append(mirror);
  const top = mark.offsetTop;
  const bottom = top + mark.offsetHeight;
  mirror.remove();

  const above = Number.parseFloat(style.paddingTop) || 0;
  const below = Number.parseFloat(style.paddingBottom) || 0;
  if (top - above < field.scrollTop) field.scrollTop = Math.max(0, top - above);
  else if (bottom + below > field.scrollTop + field.clientHeight) {
    field.scrollTop = bottom + below - field.clientHeight;
  }
}
