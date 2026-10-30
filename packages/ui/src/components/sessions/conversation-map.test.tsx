import { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ConversationMap, type MapEntry } from './conversation-map';

const entries: MapEntry[] = [
  { id: 'one', text: 'Add a test', reply: 'I will add it.' },
  { id: 'two', text: 'Now run it' },
];

function Harness() {
  const scroller = useRef<HTMLElement>(null);
  return (
    <section ref={scroller}>
      {entries.map((entry) => (
        <article key={entry.id} data-message-id={entry.id}>
          {entry.text}
        </article>
      ))}
      <ConversationMap scroller={scroller} entries={entries} />
    </section>
  );
}

it('marks each message the owner sent, says what it was, and goes there', () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const scrolled = vi.fn();
  Element.prototype.scrollIntoView = scrolled;
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  act(() => root.render(<Harness />));

  const marks = [...element.querySelectorAll<HTMLButtonElement>('.conversation-map-mark')];
  expect(marks.map((mark) => mark.getAttribute('aria-label'))).toEqual([
    'Add a test',
    'Now run it',
  ]);
  expect(marks[0]?.textContent).toContain('I will add it.');
  act(() => marks[1]?.click());
  expect(scrolled).toHaveBeenCalledOnce();
  expect(scrolled.mock.contexts[0]).toBe(element.querySelector('[data-message-id="two"]'));

  act(() => root.unmount());
  element.remove();
});
