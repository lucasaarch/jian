import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

const seen = vi.fn(async () => ({ version: '2.2.0', notes: [], unseen: [] }));
const note = {
  version: '2.2.0',
  date: '2026-09-24',
  summary: 'Agents search the web.',
  body: '## Web\n\n- **Search** with `web_search`\n- Read [pages](https://example.com)\n\n<img src=x onerror=alert(1)>',
  prerelease: false,
};

vi.mock('../../lib/api', () => ({
  gatewayApi: () => ({
    releases: async () => ({ version: '2.2.0', notes: [note], unseen: [note] }),
    markReleasesSeen: seen,
  }),
}));

it('shows what changed once, as text, and marks it read on close', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  // happy-dom has no modal dialogs; the component only needs the calls to exist.
  HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };

  const { ReleaseDialog } = await import('./dialog');
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);

  try {
    await act(async () => {
      root.render(<ReleaseDialog />);
    });

    expect(element.querySelector('h2')?.textContent).toBe("What's new in Jian 2.2.0");
    expect(element.textContent).toContain('Agents search the web.');
    expect(element.querySelector('li strong')?.textContent).toBe('Search');
    expect(element.querySelector('a')?.getAttribute('href')).toBe('https://example.com');
    // Markup in a note is shown as text, never run.
    expect(element.querySelector('img')).toBeNull();

    const button = [...element.querySelectorAll('button')].find(
      (item) => item.textContent === 'Got it',
    );

    await act(async () => {
      button?.click();
    });

    expect(seen).toHaveBeenCalledTimes(1);
    expect(element.querySelector('dialog')).toBeNull();
  } finally {
    act(() => root.unmount());
    element.remove();
  }
});
