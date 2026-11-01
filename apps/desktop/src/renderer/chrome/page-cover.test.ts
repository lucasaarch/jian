// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest';
import { coversPage } from './page-cover';

const page = { left: 500, top: 100, right: 1000, bottom: 800 };

const floating = (role: string, box: Partial<DOMRect>) => {
  const element = document.createElement('div');
  element.setAttribute('role', role);
  vi.spyOn(element, 'getBoundingClientRect').mockReturnValue(box as DOMRect);
  document.body.append(element);
};

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

it('leaves the page alone when nothing floats, or what floats is elsewhere', () => {
  expect(coversPage(page)).toBe(false);

  floating('menu', { left: 10, top: 600, right: 240, bottom: 780 });
  expect(coversPage(page)).toBe(false);
});

it('steps aside for a list that opens over the page', () => {
  floating('menu', { left: 800, top: 140, right: 1000, bottom: 400 });

  expect(coversPage(page)).toBe(true);
});

it('steps aside for a modal’s backdrop, even with its dialog beside the page', () => {
  floating('dialog', { left: 100, top: 100, right: 480, bottom: 400 });
  expect(coversPage(page)).toBe(false);

  floating('presentation', { left: 0, top: 0, right: 1400, bottom: 900 });
  expect(coversPage(page)).toBe(true);
});
