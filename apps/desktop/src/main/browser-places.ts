import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type BrowserPlace = { url: string; title: string };
type Places = { recents: BrowserPlace[]; favorites: BrowserPlace[] };

const KEPT_RECENTS = 30;
const SHOWN_RECENTS = 8;
const SEARCH = 'https://duckduckgo.com/?q=';

/** What the owner typed, as an address to open: something that is not one is a search. */
export function addressFrom(raw: string): string {
  const typed = raw.trim();
  if (/^https?:\/\//i.test(typed)) return typed;
  // `localhost:3000` reads as a scheme, and is the one place people mean plain http.
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?([/?#]|$)/i.test(typed)) return `http://${typed}`;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(typed)) return typed;
  if (!/\s/.test(typed) && /^[^/?#]+\.[a-z]{2,}([/:?#]|$)/i.test(typed)) return `https://${typed}`;
  return `${SEARCH}${encodeURIComponent(typed)}`;
}

/** The same page however it was reached; a fragment is a place inside it. */
const same = (a: string, b: string) => a.split('#')[0] === b.split('#')[0];

/**
 * The owner's recent pages and favorites, per profile like their logins, in one small file of the
 * app's data. Only pages the owner opened count: an agent's work is not their history.
 */
export class BrowserPlaces {
  private all?: Record<string, Places>;
  constructor(private readonly file: () => string) {}

  private places(scope: string): Places {
    if (!this.all) {
      try {
        this.all = JSON.parse(readFileSync(this.file(), 'utf8')) as Record<string, Places>;
      } catch {
        // No file yet, or one that cannot be read: places are a convenience, and start over.
        this.all = {};
      }
    }
    this.all[scope] ??= { recents: [], favorites: [] };
    return this.all[scope];
  }

  private save() {
    const file = this.file();
    try {
      mkdirSync(dirname(file), { recursive: true });
      // Replaced whole, so a crash leaves the last good file; readable by this user alone.
      writeFileSync(`${file}.tmp`, JSON.stringify(this.all), { mode: 0o600 });
      renameSync(`${file}.tmp`, file);
    } catch {
      // Held in memory for this run; nothing the owner is doing depends on it.
    }
  }

  visited(scope: string, url: string, title: string) {
    const places = this.places(scope);
    places.recents = [
      { url, title },
      ...places.recents.filter((place) => !same(place.url, url)),
    ].slice(0, KEPT_RECENTS);
    this.save();
  }

  /** A page's title arrives after the page does. */
  titled(scope: string, url: string, title: string) {
    const place = this.places(scope).recents.find((candidate) => same(candidate.url, url));
    if (!place || !title || place.title === title) return;
    place.title = title;
    this.save();
  }

  /** What a new tab offers: favorites, then recents that are not already among them. */
  view(scope: string) {
    const { recents, favorites } = this.places(scope);
    return {
      favorites,
      recents: recents
        .filter((place) => !favorites.some((favorite) => same(favorite.url, place.url)))
        .slice(0, SHOWN_RECENTS),
    };
  }

  isFavorite(scope: string, url: string) {
    return Boolean(url) && this.places(scope).favorites.some((place) => same(place.url, url));
  }

  setFavorite(scope: string, place: BrowserPlace, on: boolean) {
    const places = this.places(scope);
    places.favorites = places.favorites.filter((known) => !same(known.url, place.url));
    if (on) places.favorites.unshift(place);
    this.save();
  }

  forget(scope: string, url: string) {
    const places = this.places(scope);
    places.recents = places.recents.filter((place) => !same(place.url, url));
    this.save();
  }

  /** Favorites were chosen, not collected: clearing the history leaves them. */
  clearRecents(scope: string) {
    this.places(scope).recents = [];
    this.save();
  }
}
