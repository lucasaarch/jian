import { afterEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  clients: [] as unknown[],
  connect: undefined as (() => Promise<void>) | undefined,
}));

vi.mock('pg', async (importOriginal) => {
  const pg = await importOriginal<typeof import('pg')>();

  class TestClient {
    private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    private connected = false;
    private finishEnd: (() => void) | undefined;
    readonly queries: string[] = [];
    readonly connection = {
      stream: {
        destroy: () => {
          this.emit('end');
          this.finishEnd?.();
        },
      },
    };

    constructor(_options: unknown) {
      state.clients.push(this);
    }

    on(event: string, listener: (...args: unknown[]) => void): this {
      const listeners = this.listeners.get(event) ?? [];
      listeners.push(listener);
      this.listeners.set(event, listeners);
      return this;
    }

    emit(event: string, ...args: unknown[]): void {
      for (const listener of this.listeners.get(event) ?? []) listener(...args);
    }

    connect(): Promise<void> {
      return (state.connect?.() ?? Promise.resolve()).then(() => {
        this.connected = true;
      });
    }

    async query(query: string): Promise<void> {
      this.queries.push(query);
    }

    async end(): Promise<void> {
      if (this.connected) {
        this.emit('end');
        return;
      }
      await new Promise<void>((resolve) => {
        this.finishEnd = resolve;
      });
    }
  }

  return { ...pg, Client: TestClient };
});

import { PostgresStore } from '../src/storage/postgres.js';

type TestClient = {
  queries: string[];
  emit: (event: string, ...args: unknown[]) => void;
};

const stores: PostgresStore[] = [];
const clients = () => state.clients as TestClient[];

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  state.clients.length = 0;
  state.connect = undefined;
  vi.useRealTimers();
});

it('closes without waiting for an in-flight listener connection', async () => {
  let finishConnect!: () => void;
  state.connect = () =>
    new Promise<void>((resolve) => {
      finishConnect = resolve;
    });
  const store = new PostgresStore('postgres://test:test@127.0.0.1:5432/test');
  stores.push(store);
  const closing = store.close();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const closedBeforeConnect = await Promise.race([
    closing.then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), 500);
    }),
  ]);
  if (timer) clearTimeout(timer);

  finishConnect();
  await closing;
  stores.splice(stores.indexOf(store), 1);
  expect(closedBeforeConnect).toBe(true);
});

it('reconnects its notification listener after a dropped database connection', async () => {
  vi.useFakeTimers();
  const store = new PostgresStore('postgres://test:test@127.0.0.1:5432/test');
  stores.push(store);

  await Promise.resolve();
  await Promise.resolve();
  expect(clients()[0]?.queries).toContain('LISTEN jian_events');

  const waiting = store.waitForEvent('profile', new AbortController().signal);
  clients()[0]?.emit('error', new Error('connection lost'));
  await vi.advanceTimersByTimeAsync(1_000);

  expect(clients()).toHaveLength(2);
  expect(clients()[1]?.queries).toContain('LISTEN jian_events');
  await expect(waiting).resolves.toBeUndefined();

  const notified = store.waitForEvent('after-reconnect', new AbortController().signal);
  clients()[1]?.emit('notification', {
    channel: 'jian_events',
    payload: 'after-reconnect',
  });
  await expect(notified).resolves.toBeUndefined();
});
