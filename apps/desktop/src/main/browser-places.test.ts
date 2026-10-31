import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addressFrom, BrowserPlaces } from './browser-places';

const places: string[] = [];
afterEach(() => {
  for (const place of places.splice(0)) rmSync(place, { recursive: true, force: true });
});
const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), 'jian-places-'));
  places.push(dir);
  const file = join(dir, 'nested', 'places.json');
  return { file, store: new BrowserPlaces(() => file) };
};

describe('what a typed address means', () => {
  it.each([
    ['https://atlas.test/docs', 'https://atlas.test/docs'],
    ['atlas.test', 'https://atlas.test'],
    ['atlas.test/docs?a=1', 'https://atlas.test/docs?a=1'],
    ['  atlas.test  ', 'https://atlas.test'],
    ['localhost:3000', 'http://localhost:3000'],
    ['localhost', 'http://localhost'],
    ['127.0.0.1:4310/health', 'http://127.0.0.1:4310/health'],
    ['ftp://atlas.test', 'ftp://atlas.test'],
  ])('opens %s', (typed, address) => {
    expect(addressFrom(typed)).toBe(address);
  });

  it.each([['how to make coffee'], ['coffee'], ['node.js streams explained']])(
    'searches for %s',
    (typed) => {
      expect(addressFrom(typed)).toBe(`https://duckduckgo.com/?q=${encodeURIComponent(typed)}`);
    },
  );
});

describe('recent pages and favorites', () => {
  it('keeps the latest visit first, once per page, a fragment being the same page', () => {
    const { store } = fresh();
    store.visited('one', 'https://atlas.test/', 'Atlas');
    store.visited('one', 'https://nova.test/', 'Nova');
    store.visited('one', 'https://atlas.test/#docs', 'Atlas Docs');

    expect(store.view('one').recents.map((place) => place.url)).toEqual([
      'https://atlas.test/#docs',
      'https://nova.test/',
    ]);
  });

  it('never shows one profile the places of another', () => {
    const { store } = fresh();
    store.visited('one', 'https://atlas.test/', 'Atlas');
    store.setFavorite('one', { url: 'https://nova.test/', title: 'Nova' }, true);

    expect(store.view('two')).toEqual({ favorites: [], recents: [] });
    expect(store.isFavorite('two', 'https://nova.test/')).toBe(false);
  });

  it('lists a favorite once, and takes it back out', () => {
    const { store } = fresh();
    store.visited('one', 'https://atlas.test/', 'Atlas');
    store.setFavorite('one', { url: 'https://atlas.test/', title: 'Atlas' }, true);

    expect(store.isFavorite('one', 'https://atlas.test/#top')).toBe(true);
    expect(store.view('one').recents).toEqual([]);
    expect(store.view('one').favorites).toHaveLength(1);

    store.setFavorite('one', { url: 'https://atlas.test/', title: 'Atlas' }, false);
    expect(store.view('one').favorites).toEqual([]);
    expect(store.view('one').recents).toHaveLength(1);
  });

  it('clears the history without touching what the owner chose to keep', () => {
    const { store } = fresh();
    store.visited('one', 'https://atlas.test/', 'Atlas');
    store.setFavorite('one', { url: 'https://nova.test/', title: 'Nova' }, true);

    store.clearRecents('one');

    expect(store.view('one').recents).toEqual([]);
    expect(store.view('one').favorites).toHaveLength(1);
  });

  it('shows a handful, and survives a restart in a file only its owner reads', () => {
    const { store, file } = fresh();
    for (let page = 0; page < 40; page += 1) store.visited('one', `https://a.test/${page}`, '');
    store.titled('one', 'https://a.test/39', 'Latest');

    const again = new BrowserPlaces(() => file);
    expect(again.view('one').recents).toHaveLength(8);
    expect(again.view('one').recents[0]).toEqual({ url: 'https://a.test/39', title: 'Latest' });
    expect(JSON.parse(readFileSync(file, 'utf8')).one.recents).toHaveLength(30);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('starts over from a file it cannot read', () => {
    const { store, file } = fresh();
    store.visited('one', 'https://atlas.test/', 'Atlas');
    rmSync(file);
    expect(new BrowserPlaces(() => file).view('one').recents).toEqual([]);
  });
});
