import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { Markdown } from './markdown';

it('draws a fenced block as code: its language, numbered lines and colours', () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const element = document.createElement('div');
  const root = createRoot(element);
  act(() =>
    root.render(
      <Markdown text={'Here:\n\n```python\nif b == 0:\n    raise ValueError()\n```\n'} />,
    ),
  );

  expect(element.querySelector('.code-block-head')?.textContent).toContain('python');
  const lines = [...element.querySelectorAll('.code-block-line')];
  expect(lines.map((line) => line.getAttribute('data-line'))).toEqual(['1', '2']);
  // The numbers are drawn beside the code, never part of it.
  expect(lines[1]?.textContent).toBe('    raise ValueError()\n');
  expect(element.querySelector('.code-block .hljs-keyword')?.textContent).toBe('if');
  const wrap = element.querySelector<HTMLButtonElement>('[role="switch"]');
  expect(wrap?.getAttribute('aria-checked')).toBe('false');
  act(() => wrap?.click());
  expect(wrap?.getAttribute('aria-checked')).toBe('true');
  expect(element.querySelector('.code-block')?.hasAttribute('data-wrap')).toBe(true);
  expect(element.querySelector('.code-block-lines')?.textContent).toBe(
    'if b == 0:\n    raise ValueError()\n',
  );
  act(() => wrap?.click());
  expect(wrap?.getAttribute('aria-checked')).toBe('false');
  act(() => root.unmount());
});
