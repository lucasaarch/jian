import type { PersistedClient, Persister } from '@tanstack/react-query-persist-client';

/**
 * Where an app keeps what it read from each gateway: one IndexedDB database on this computer,
 * a record per gateway. It lives with the app's other data and leaves with it.
 */
const DATABASE = 'jian-cache';
const STORE = 'gateways';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function act<T>(
  mode: IDBTransactionMode,
  work: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = work(database.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } finally {
    database.close();
  }
}

/** How often, at most, the cache is written as it changes, in milliseconds. */
const WRITE_MS = 1_000;

/**
 * Keeps one gateway's cache under `key`. Writes come in bursts as a turn moves; the last state
 * of a burst is written once it settles. A storage that cannot be opened only means nothing is
 * kept: the app reads the gateway as it would without it.
 */
export function gatewayPersister(key: string): Persister {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let latest: PersistedClient | undefined;

  return {
    persistClient: (client) => {
      latest = client;
      clearTimeout(timer);
      timer = setTimeout(() => {
        void act('readwrite', (store) => store.put(latest, key)).catch(() => {});
      }, WRITE_MS);
    },
    restoreClient: () =>
      act<PersistedClient | undefined>('readonly', (store) => store.get(key)).catch(
        () => undefined,
      ),
    removeClient: () => forgetGatewayCache(key),
  };
}

/** Drops what was kept for a gateway, as when it is removed from the app. */
export async function forgetGatewayCache(key: string): Promise<void> {
  await act('readwrite', (store) => store.delete(key)).catch(() => {});
}
