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

  it('leaves text that is not at the end alone', () => {
    expect(streamable('a_b and c')).toBe('a_b and c');
    expect(streamable('snake_case_name')).toBe('snake_case_name');
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
    draw('one\n\ntwo three');
    expect(element.querySelector('p')).toBe(first);
    expect(element.textContent).toBe('onetwo three');
  });
});
