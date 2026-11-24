import { createServer, type Server, type Socket } from 'node:net';
import {
  FORWARD_CONNECTIONS_MAX,
  FORWARD_IDLE_MS,
  FORWARDS_PER_PROFILE,
  REMOTE_BROWSER_CAPABILITY,
  REMOTE_FORWARDS_CAPABILITY,
} from '@jian/contracts';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { forwardTools } from '../src/agent/forward-tools.js';
import { createApp } from '../src/app.js';
import { Forwards } from '../src/forwards/service.js';
import { buildServices } from '../src/services.js';
import { remoteControlFor } from '../src/skills/builtin/remote-control.js';
import { testServices } from './helpers/services.js';

const token = 'synthetic-admin-token-with-32-characters';
const owner = { authorization: `Bearer ${token}` };
const CAPABILITIES = `${REMOTE_FORWARDS_CAPABILITY},${REMOTE_BROWSER_CAPABILITY}`;

const closers: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

/** A real TCP server on 127.0.0.1 that sends back what it reads; its sockets are kept to look at. */
async function echo() {
  const sockets: Socket[] = [];
  const server: Server = createServer((socket) => {
    sockets.push(socket);
    socket.on('data', (chunk) => socket.write(chunk));
    socket.on('error', () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return { port: address.port, sockets };
}

/** A gateway with the forwards service on a real port: the tunnel streams, inject cannot read it. */
async function gateway(openWaitMs = 50) {
  const services = await testServices();
  const forwards = new Forwards(services.store, services.remote, Date.now, openWaitMs);
  const app: FastifyInstance = createApp({ ...services, forwards, token, logger: false });
  closers.push(() => app.close());
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  const profile = await services.profiles.createProfile({ name: 'Owner', instructions: 'Help.' });
  const session = await services.sessions.createGatewaySession(profile.id, {});

  /** A machine whose worker has polled once, saying what it can do. */
  const machine = async (name: string, capabilities = CAPABILITIES) => {
    const created = await services.remote.create({ name });
    const authorization = `Bearer ${created.token}`;
    await services.remote.poll(created.id, authorization, 'darwin-arm64', capabilities);
    const call = (path: string, init: RequestInit = {}) =>
      fetch(`${base}/v1/remote/worker/${created.id}/${path}`, {
        ...init,
        headers: {
          authorization,
          ...(init.body ? { 'content-type': 'application/json' } : {}),
          ...init.headers,
        },
      });
    return { id: created.id, authorization, call };
  };
  return { services, forwards, app, base, profile, session, machine };
}

/** Creates a forward and answers for the worker: it opened the local port. */
async function opened(
  g: Awaited<ReturnType<typeof gateway>>,
  worker: Awaited<ReturnType<Awaited<ReturnType<typeof gateway>>['machine']>>,
  port: number,
) {
  const pending = g.forwards.create(
    { profileId: g.profile.id, sessionId: g.session.id },
    { port, machine: worker.id },
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  const [waiting] = g.forwards.list(g.profile.id, g.session.id);
  await worker.call(`forwards/${waiting?.id}/state`, {
    method: 'POST',
    body: JSON.stringify({ status: 'open', localPort: 41234 }),
  });
  return pending;
}

const decode = (frame: string) => {
  const [, event = '', data = ''] = /event: (\w+)\ndata: (.*)/.exec(frame) ?? [];
  return { event, data: JSON.parse(data || '{}') as { data?: string } };
};

describe('forwards', () => {
  it('carries bytes both ways to a real TCP server, and closes it from either end', async () => {
    const g = await gateway();
    const server = await echo();
    const worker = await g.machine('Studio');
    const forward = await opened(g, worker, server.port);
    expect(forward).toMatchObject({ status: 'open', localPort: 41234, machineName: 'Studio' });

    const path = `forwards/${forward.id}/connections`;
    const { id } = (await (await worker.call(path, { method: 'POST' })).json()) as { id: string };
    // The server's own view: it was reached on its own loopback.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(server.sockets[0]?.remoteAddress).toMatch(/127\.0\.0\.1|::1/);

    const stream = await worker.call(`${path}/${id}/stream`);
    expect(stream.headers.get('content-type')).toBe('text/event-stream');
    const reader = stream.body?.getReader();
    if (!reader) throw new Error('no stream');
    const heard: string[] = [];
    const frames = (async () => {
      let text = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        text += new TextDecoder().decode(value);
        const parts = text.split('\n\n');
        text = parts.pop() ?? '';
        for (const part of parts) if (part.startsWith('event:')) heard.push(part);
      }
    })();

    const sent = Buffer.alloc(300_000, 7);
    const up = await worker.call(`${path}/${id}/data`, {
      method: 'POST',
      body: JSON.stringify({ data: sent.toString('base64') }),
    });
    expect(up.status).toBe(204);
    const received = () =>
      Buffer.concat(
        heard
          .map(decode)
          .filter((frame) => frame.event === 'data')
          .map((frame) => Buffer.from(frame.data.data ?? '', 'base64')),
      );
    await expect.poll(() => received().length, { timeout: 15_000 }).toBe(sent.length);
    expect(received().equals(sent)).toBe(true);

    // The computer's side closes: the server sees the socket end and the stream says so.
    const closed = new Promise<void>((resolve) =>
      server.sockets[0]?.once('close', () => resolve()),
    );
    expect((await worker.call(`${path}/${id}`, { method: 'DELETE' })).status).toBe(204);
    await closed;
    await frames;
    expect(heard.map((frame) => decode(frame).event)).toContain('end');
  });

  it('tells the server side closing to the worker through the stream', async () => {
    const g = await gateway();
    const server = await echo();
    const worker = await g.machine('Studio');
    const forward = await opened(g, worker, server.port);
    const path = `forwards/${forward.id}/connections`;
    const { id } = (await (await worker.call(path, { method: 'POST' })).json()) as { id: string };
    const stream = await worker.call(`${path}/${id}/stream`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    server.sockets[0]?.end();
    expect(await stream.text()).toContain('event: end');
  });

  it('keeps a forward to the machine it was made for, and to the profile that made it', async () => {
    const g = await gateway();
    const server = await echo();
    const a = await g.machine('A');
    const b = await g.machine('B');
    const forward = await opened(g, a, server.port);

    // B holds its own valid token and still cannot touch A's forward.
    for (const [path, method] of [
      [`forwards/${forward.id}/connections`, 'POST'],
      [`forwards/${forward.id}/state`, 'POST'],
    ] as const) {
      const response = await b.call(path, {
        method,
        body: JSON.stringify({ status: 'failed', error: 'x' }),
      });
      expect(response.status).toBe(404);
    }
    expect(g.forwards.assigned(b.id)).toEqual([]);
    expect(g.forwards.assigned(a.id)).toEqual([{ id: forward.id, port: server.port }]);

    const wrong = await fetch(
      `${g.base}/v1/remote/worker/${a.id}/forwards/${forward.id}/connections`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${'x'.repeat(43)}` },
      },
    );
    expect(wrong.status).toBe(401);

    // Another agent neither lists nor stops it; the same ids are simply not found.
    const other = await g.services.profiles.createProfile({ name: 'Other', instructions: 'Help.' });
    const otherSession = await g.services.sessions.createGatewaySession(other.id, {});
    const list = await g.app.inject({
      url: `/v1/profiles/${other.id}/sessions/${otherSession.id}/forwards`,
      headers: owner,
    });
    expect(list.json()).toEqual([]);
    const crossed = await g.app.inject({
      url: `/v1/profiles/${other.id}/sessions/${g.session.id}/forwards`,
      headers: owner,
    });
    expect(crossed.statusCode).toBe(404);
    const stop = await g.app.inject({
      method: 'DELETE',
      url: `/v1/profiles/${other.id}/forwards/${forward.id}`,
      headers: owner,
    });
    expect(stop.statusCode).toBe(404);
    expect(g.forwards.list(g.profile.id, g.session.id)).toHaveLength(1);
  });

  it('closes the connections when the owner stops it, and tells the worker to drop the port', async () => {
    const g = await gateway();
    const server = await echo();
    const worker = await g.machine('Studio');
    const forward = await opened(g, worker, server.port);
    const path = `forwards/${forward.id}/connections`;
    await worker.call(path, { method: 'POST' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const closed = new Promise<void>((resolve) =>
      server.sockets[0]?.once('close', () => resolve()),
    );

    const listed = await g.app.inject({
      url: `/v1/profiles/${g.profile.id}/sessions/${g.session.id}/forwards`,
      headers: owner,
    });
    expect(listed.json()).toMatchObject([{ id: forward.id, status: 'open', localPort: 41234 }]);
    const stop = await g.app.inject({
      method: 'DELETE',
      url: `/v1/profiles/${g.profile.id}/forwards/${forward.id}`,
      headers: owner,
    });
    expect(stop.statusCode).toBe(204);
    await closed;
    const polled = await fetch(`${g.base}/v1/remote/worker/${worker.id}/tasks/next`, {
      headers: { authorization: worker.authorization, 'x-jian-remote-capabilities': CAPABILITIES },
    });
    expect(await polled.json()).toEqual({ task: null, forwards: [] });
    // The panel hears of it as it hears of everything else: one event on the profile's feed.
    const events = await g.services.store.db.execute(
      `select type from events where profile_id = '${g.profile.id}' and type = 'forward.changed'` as never,
    );
    expect(JSON.stringify(events)).toContain('forward.changed');
  });

  it('limits forwards per agent and connections per forward, and reports a closed port', async () => {
    const g = await gateway();
    const server = await echo();
    const worker = await g.machine('Studio');
    const run = { profileId: g.profile.id, sessionId: g.session.id };

    for (let port = 3000; port < 3000 + FORWARDS_PER_PROFILE; port++) {
      await g.forwards.create(run, { port, machine: worker.id });
    }
    await expect(g.forwards.create(run, { port: 4000, machine: worker.id })).rejects.toMatchObject({
      statusCode: 409,
    });
    // The same port again is the same forward, not another one.
    const [first] = g.forwards.list(run.profileId, run.sessionId);
    await expect(g.forwards.create(run, { port: 3000, machine: worker.id })).resolves.toMatchObject(
      {
        id: first?.id,
      },
    );

    const g2 = await gateway();
    const w2 = await g2.machine('Studio');
    const forward = await opened(g2, w2, server.port);
    const path = `forwards/${forward.id}/connections`;
    for (let n = 0; n < FORWARD_CONNECTIONS_MAX; n++) {
      expect((await w2.call(path, { method: 'POST' })).status).toBe(201);
    }
    expect((await w2.call(path, { method: 'POST' })).status).toBe(429);

    const dead = await g2.forwards.create(
      { profileId: g2.profile.id, sessionId: g2.session.id },
      { port: 9, machine: w2.id },
    );
    await w2.call(`forwards/${dead.id}/state`, {
      method: 'POST',
      body: JSON.stringify({ status: 'open', localPort: 41235 }),
    });
    const refused = await w2.call(`forwards/${dead.id}/connections`, { method: 'POST' });
    expect(refused.status).toBe(502);
  });

  it('closes a connection that carried nothing for five minutes, and keeps a busy one', async () => {
    const services = await testServices();
    let now = Date.now();
    const forwards = new Forwards(services.store, services.remote, () => now, 50);
    const app = createApp({ ...services, forwards, token, logger: false });
    closers.push(() => app.close());
    const base = await app.listen({ host: '127.0.0.1', port: 0 });
    const profile = await services.profiles.createProfile({ name: 'Owner', instructions: 'Help.' });
    const session = await services.sessions.createGatewaySession(profile.id, {});
    const created = await services.remote.create({ name: 'Studio' });
    const authorization = `Bearer ${created.token}`;
    await services.remote.poll(created.id, authorization, 'linux-x64', CAPABILITIES);
    const server = await echo();
    const call = (path: string, init: RequestInit = {}) =>
      fetch(`${base}/v1/remote/worker/${created.id}/${path}`, {
        ...init,
        headers: { authorization, ...(init.body ? { 'content-type': 'application/json' } : {}) },
      });
    const forward = await forwards.create(
      { profileId: profile.id, sessionId: session.id },
      { port: server.port, machine: created.id },
    );
    await call(`forwards/${forward.id}/state`, {
      method: 'POST',
      body: JSON.stringify({ status: 'open', localPort: 41236 }),
    });
    const path = `forwards/${forward.id}/connections`;
    const idle = ((await (await call(path, { method: 'POST' })).json()) as { id: string }).id;
    const busy = ((await (await call(path, { method: 'POST' })).json()) as { id: string }).id;
    await new Promise((resolve) => setTimeout(resolve, 20));
    forwards.sweep();

    now += FORWARD_IDLE_MS - 1000;
    await call(`${path}/${busy}/data`, {
      method: 'POST',
      body: JSON.stringify({ data: Buffer.from('hi').toString('base64') }),
    });
    forwards.sweep();
    now += 2000;
    forwards.sweep();
    await expect
      .poll(
        async () =>
          (await call(`${path}/${idle}/data`, { method: 'POST', body: '{"data":"AA=="}' })).status,
      )
      .toBe(404);
    expect(
      (await call(`${path}/${busy}/data`, { method: 'POST', body: '{"data":"AA=="}' })).status,
    ).not.toBe(404);
  });

  it('refuses a machine whose worker cannot forward, and says what to do', async () => {
    const g = await gateway();
    const old = await g.machine('Old', REMOTE_BROWSER_CAPABILITY);
    await expect(
      g.forwards.create(
        { profileId: g.profile.id, sessionId: g.session.id },
        { port: 3000, machine: old.id },
      ),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('update the desktop app'),
    });
    // No desktop app online at all: the agent is told to name a machine.
    await expect(
      new Forwards((await testServices()).store, g.services.remote).create(
        { profileId: g.profile.id, sessionId: g.session.id },
        { port: 3000 },
      ),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('picks the one desktop app online, and asks for a machine when there are none or several', async () => {
    const g = await gateway();
    const run = { profileId: g.profile.id, sessionId: g.session.id };
    await expect(g.forwards.create(run, { port: 3000 })).rejects.toMatchObject({ statusCode: 409 });
    const only = await g.machine('Mac');
    await g.machine('Server box', REMOTE_FORWARDS_CAPABILITY);
    await expect(g.forwards.create(run, { port: 3000 })).resolves.toMatchObject({
      machineId: only.id,
    });
    await g.machine('Second Mac');
    await expect(g.forwards.create(run, { port: 3001 })).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe('where forwards exist', () => {
  it('is offered only to a server gateway whose process serves and runs', async () => {
    const make = async (mode: 'server' | 'local', role: 'all' | 'api' | 'worker') => {
      const base = await testServices();
      return buildServices({
        store: base.store,
        vault: base.vault,
        gatewayVault: base.gatewayVault,
        mode,
        role,
      }).forwards;
    };
    expect(await make('server', 'all')).toBeInstanceOf(Forwards);
    expect(await make('local', 'all')).toBeUndefined();
    expect(await make('server', 'api')).toBeUndefined();
    expect(await make('server', 'worker')).toBeUndefined();
  });

  it('answers a panel of a gateway without them that nothing is open', async () => {
    const services = await testServices();
    const app = createApp({ ...services, token, logger: false });
    closers.push(() => app.close());
    const profile = await services.profiles.createProfile({ name: 'Owner', instructions: 'Help.' });
    const session = await services.sessions.createGatewaySession(profile.id, {});
    const list = await app.inject({
      url: `/v1/profiles/${profile.id}/sessions/${session.id}/forwards`,
      headers: owner,
    });
    expect(list.json()).toEqual([]);
  });

  it('gives the agent forward_port and close_forward, bound to its conversation', async () => {
    const calls: unknown[] = [];
    const tools = forwardTools(
      { profileId: 'p', sessionId: 's' },
      {
        create: async (_run: unknown, input: { port: number; machine?: string | undefined }) => {
          calls.push(input);
          return {
            id: '00000000-0000-4000-8000-000000000001',
            sessionId: 's',
            machineId: 'm',
            machineName: 'Mac',
            remotePort: input.port,
            status: 'open' as const,
            localPort: 41234,
            createdAt: new Date().toISOString(),
          };
        },
        closePort: async () => 0,
      } as never,
      '00000000-0000-4000-8000-0000000000aa',
    );
    const execute = tools.forward_port?.execute as (
      input: unknown,
      options: unknown,
    ) => Promise<{
      message: string;
    }>;
    expect((await execute({ port: 3000 }, {})).message).toBe(
      'Open on Mac at http://localhost:41234',
    );
    // A conversation aimed at one machine forwards there, whatever the agent names.
    expect(calls).toEqual([{ port: 3000, machine: '00000000-0000-4000-8000-0000000000aa' }]);
    await expect(execute({ port: 3000, machine: 'Other' }, {})).rejects.toMatchObject({
      statusCode: 403,
    });
  });
});

describe('the remote-control skill', () => {
  it('names forward_port only to a run that has it', () => {
    expect(remoteControlFor(undefined, true).instructions).toContain('forward_port');
    expect(remoteControlFor().instructions).not.toContain('forward_port');
  });
});
