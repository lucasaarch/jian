import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { type AddressInfo, connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import {
  FORWARD_CHUNK_MAX,
  FORWARD_LOCAL_PORTS,
  REMOTE_FORWARDS_CAPABILITY,
} from '@jian/contracts';
import { CHUNK_MAX, FORWARDS_CAPABILITY, LOCAL_PORTS } from '../src/forwards/limits.ts';
import { createLogger, createWorkerState, detectCapabilities, runWorker } from '../src/index.ts';

const machineId = '0b6f6a1e-3f0e-4c55-8a7e-2d9f4c1b7a21';
const forwardId = '7d1c2f0e-4a59-4c11-9a52-1f1b5e7d3c10';
const dir = mkdtempSync(join(tmpdir(), 'jian-forwards-'));
after(() => rmSync(dir, { recursive: true, force: true }));

test('the copied constants equal the contract', () => {
  assert.equal(FORWARDS_CAPABILITY, REMOTE_FORWARDS_CAPABILITY);
  assert.equal(CHUNK_MAX, FORWARD_CHUNK_MAX);
  assert.deepEqual(LOCAL_PORTS, FORWARD_LOCAL_PORTS);
});

test('a machine that can run the worker says it forwards', async () => {
  assert.ok((await detectCapabilities()).includes(FORWARDS_CAPABILITY));
});

/** A gateway that assigns one forward, echoes upper-cased uploads and records what it saw. */
async function gateway() {
  const seen: string[] = [];
  const state = { assigned: true, reported: undefined as unknown, uploaded: 0 };
  let stream: ServerResponse | undefined;
  const server = createServer((request, response) => {
    const url = request.url ?? '';
    const json = (code: number, body?: unknown) => {
      response.writeHead(code, { 'content-type': 'application/json' });
      response.end(body === undefined ? undefined : JSON.stringify(body));
    };
    if (url === '/health') return json(200, { status: 'ok', version: '1.1.4' });
    if (url.endsWith('/tasks/next')) {
      return json(200, {
        task: null,
        forwards: state.assigned ? [{ id: forwardId, port: 3000 }] : [],
      });
    }
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      seen.push(`${request.method} ${url.split('/forwards/')[1]}`);
      if (url.endsWith('/state')) {
        state.reported = JSON.parse(body);
        return json(200, { ok: true });
      }
      if (url.endsWith('/connections')) {
        // Only a request with a body may say it is JSON, or the gateway refuses it.
        assert.equal(request.headers['content-type'], undefined);
        return json(201, { id: 'c1' });
      }
      if (url.endsWith('/stream')) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(': connected\n\n');
        stream = response;
        return;
      }
      if (url.endsWith('/data')) {
        const bytes = Buffer.from((JSON.parse(body) as { data: string }).data, 'base64');
        state.uploaded += bytes.length;
        const echoed = Buffer.from(bytes.toString().toUpperCase()).toString('base64');
        stream?.write(`event: data\ndata: ${JSON.stringify({ data: echoed })}\n\n`);
        response.writeHead(204).end();
        return;
      }
      if (request.method === 'DELETE') return json(204);
      json(404, {});
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, seen, state, close: () => server.close() };
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i += 1) await new Promise((r) => setTimeout(r, 50));
  assert.ok(check(), 'timed out');
};

test('a forward listens on loopback in the range, carries bytes, and closes when it is withdrawn', async () => {
  const gw = await gateway();
  const stop = new AbortController();
  const running = runWorker({
    config: { gateway: gw.base, machineId, token: 'synthetic-worker-token' },
    version: '1.1.4',
    log: createLogger({ path: join(dir, 'w.log'), echo: false }),
    state: createWorkerState({ path: join(dir, 'w.json'), version: '1.1.4' }),
    capabilities: [FORWARDS_CAPABILITY],
    signal: stop.signal,
  });
  try {
    await until(() => gw.state.reported !== undefined);
    const reported = gw.state.reported as { status: string; localPort: number };
    assert.equal(reported.status, 'open');
    assert.ok(reported.localPort >= 41000 && reported.localPort <= 41999);

    const socket = connect(reported.localPort, '127.0.0.1');
    const received: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => received.push(chunk));
    await new Promise((resolve) => socket.once('connect', resolve));
    socket.write('hello');
    await until(() => Buffer.concat(received).toString() === 'HELLO');
    assert.ok(gw.seen.includes(`POST ${forwardId}/connections`));

    socket.destroy();
    await until(() =>
      gw.seen.some((line) => line.endsWith('/connections/c1') && line.startsWith('DELETE')),
    );

    // Withdrawn by the gateway: the next poll closes the port.
    gw.state.assigned = false;
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const outcome = await new Promise<string>((resolve) => {
      const probe = connect(reported.localPort, '127.0.0.1');
      probe.once('connect', () => {
        probe.destroy();
        resolve('open');
      });
      probe.once('error', () => resolve('closed'));
    });
    assert.equal(outcome, 'closed');
  } finally {
    stop.abort();
    await running;
    gw.close();
  }
});
