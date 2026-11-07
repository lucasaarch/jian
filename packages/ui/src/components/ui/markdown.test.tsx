import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Markdown, streamable } from './markdown';

let element: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  element = document.createElement('div');
  document.body.append(element);
  root = createRoot(element);
});
afterEach(() => {
  act(() => root.unmount());
  element.remove();
});

const draw = (text: string, streaming = true) =>
  act(() => root.render(<Markdown text={text} streaming={streaming} />));

describe('streamed Markdown', () => {
  it('draws an unterminated fence as a code block', () => {
    draw('a\n```ts\nconst x');
    expect(element.querySelector('.code-block')?.textContent).toContain('const x');
  });

  it.each([
    ['say **bo', 'say bo'],
    ['say `co', 'say co'],
    ['say _it', 'say it'],
    ['say *it', 'say it'],
  ])('hides one trailing marker in %s', (text, shown) => {
    draw(text);
    expect(element.textContent).toBe(shown);
  });

  it.each([
    'a_b and c',
    'snake_case_name',
    'use `*.ts` files',
    'see `_x`',
    '5 * 3',
    'see https://x.dev/_next',
  ])('leaves settled text alone: %s', (text) => {
    expect(streamable(text)).toBe(text);
  });

  it('hides an open bold after a star bullet', () => {
    draw('* **Lab');
    expect(element.querySelector('li')?.textContent).toBe('Lab');
    expect(element.textContent).not.toContain('*');
  });

  it('hides only the open bold when an earlier star never closed', () => {
    // The earlier `*it` stays literal: it was never closed before the bold opened.
    draw('*it **bo');
    expect(element.textContent).toBe('*it bo');
  });

  it('renders a closed bold span as strong', () => {
    draw('say **bold**');
    expect(element.querySelector('strong')?.textContent).toBe('bold');
  });

  it('draws no word spans while streaming', () => {
    draw('one two three');
    expect(element.querySelector('.stream-word')).toBeNull();
    expect(element.querySelector('span')).toBeNull();
  });

  it('keeps earlier blocks while the last one grows', () => {
    draw('one\n\ntwo');
    const first = element.querySelector('p');
    const word = first?.firstChild;
    draw('one\n\ntwo three');
    expect(element.querySelector('p')).toBe(first);
    // A plain text node, not a span per word, so nothing is replaced as text arrives.
    expect(word?.nodeType).toBe(Node.TEXT_NODE);
    expect(first?.firstChild).toBe(word);
    expect(element.textContent).toBe('onetwo three');
  });
});
