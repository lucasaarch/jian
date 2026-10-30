import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import type { RemoteTask } from '@jian/contracts';
import { createLogger, createWorkerState, runWorker, type Updater } from '../src/index.ts';

const machineId = '0b6f6a1e-3f0e-4c55-8a7e-2d9f4c1b7a21';
const task: RemoteTask = {
  id: '6f1c2f0e-4a59-4c11-9a52-1f1b5e7d3c10',
  kind: 'update',
  command: null,
  cwd: null,
  timeoutMs: 300_000,
  update: { version: '1.2.0' },
};

const dir = mkdtempSync(join(tmpdir(), 'jian-worker-update-'));
after(() => rmSync(dir, { recursive: true, force: true }));

/**
 * A gateway on 1.2.0 that hands out one update task and records, in order, what reached it;
 * `events` is shared with the updater so the order of the two sides can be read together.
 */
async function gateway(events: string[], onResult = () => {}) {
  let handed = false;
  const results: unknown[] = [];
  const server = createServer((request, response) => {
    const url = request.url ?? '';
    const send = (body: unknown) => {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(body));
    };
    if (url === '/health') return send({ status: 'ok', version: '1.2.0' });
    if (url.endsWith('/tasks/next')) {
      const next = handed ? null : task;
      handed = true;
      return send({ task: next });
    }
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      events.push('result posted');
      results.push(JSON.parse(body));
      onResult();
      send({ ok: true });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, results, close: () => server.close() };
}

function worker(
  base: string,
  name: string,
  update?: Updater,
  signal: AbortSignal = AbortSignal.timeout(5_000),
) {
  return runWorker({
    config: { gateway: base, machineId, token: 'synthetic-worker-token' },
    version: '1.1.4',
    log: createLogger({ path: join(dir, `${name}.log`), echo: false }),
    state: createWorkerState({ path: join(dir, `${name}.json`), version: '1.1.4' }),
    capabilities: update ? ['update-npm'] : [],
    ...(update ? { update } : {}),
    signal,
  });
}

test('the gateway hears how an update went before the worker restarts on the new release', async () => {
  const events: string[] = [];
  const server = await gateway(events);
  try {
    await worker(server.base, 'updates', async (received) => ({
      result: {
        taskId: received.id,
        exitCode: 0,
        stdout: 'Updated Jian Remote from 1.1.4 to 1.2.0.',
        stderr: '',
        update: { from: '1.1.4', to: '1.2.0' },
      },
      restart: async () => {
        events.push('restarted');
      },
    }));
    assert.deepEqual(events, ['result posted', 'restarted']);
    assert.deepEqual(server.results, [
      {
        taskId: task.id,
        exitCode: 0,
        stdout: 'Updated Jian Remote from 1.1.4 to 1.2.0.',
        stderr: '',
        timedOut: false,
        update: { from: '1.1.4', to: '1.2.0' },
      },
    ]);
  } finally {
    server.close();
  }
});

test('a worker that cannot update itself answers the task with what to do instead', async () => {
  const events: string[] = [];
  const stop = new AbortController();
  const server = await gateway(events, () => stop.abort());
  try {
    await worker(server.base, 'cannot', undefined, stop.signal);
    assert.deepEqual(server.results, [
      {
        taskId: task.id,
        exitCode: 1,
        stdout: '',
        stderr: 'This Jian Remote cannot update itself; update it where it was installed.',
        timedOut: false,
      },
    ]);
  } finally {
    server.close();
  }
});
