import { describe, expect, it } from 'vitest';
import { computerName } from '../src/main/machines/identity';
import {
  type GatewayAccess,
  type MachineEntries,
  type MachineEntry,
  MachineRegistry,
} from '../src/main/machines/registry';
import { ComputerSharing, type WorkerHost, type WorkerTarget } from '../src/main/machines/sharing';

const HOST_TOKEN = 'host-token-synthetic-0000000000000000000000';
const server: GatewayAccess = { id: 'gw-1', url: 'https://jian.example.com', token: HOST_TOKEN };
const local: GatewayAccess = {
  id: 'local',
  url: 'http://127.0.0.1:60378',
  local: true,
  token: HOST_TOKEN,
};
const identity = { name: 'Studio Mac', platform: 'darwin-arm64', system: 'macOS 27.2' };

/**
 * A gateway's machine routes, as far as registration reaches them: the owner's machines, each
 * with the one worker token it accepts, signed for with the host token.
 */
function fakeGateway(options: { describes?: boolean } = {}) {
  const machines = new Map<string, { name: string; platform?: string; token: string }>();
  let made = 0;
  const requests: string[] = [];
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const auth = new Headers(init?.headers).get('authorization') ?? '';
    requests.push(`${method} ${url.pathname}`);
    // A step for the requests above to interleave on, as they would over a network.
    await new Promise((resolve) => setTimeout(resolve, 1));

    const worker = /^\/v1\/remote\/worker\/([^/]+)\/disconnect$/.exec(url.pathname);
    if (worker) {
      const machine = machines.get(worker[1] ?? '');
      return machine && auth === `Bearer ${machine.token}`
        ? json(200, { ok: true })
        : json(401, { error: 'Unauthorized' });
    }
    if (auth !== `Bearer ${HOST_TOKEN}`) return json(401, { error: 'Unauthorized' });
    if (method === 'GET' && url.pathname === '/v1/remote/machines') {
      return json(
        200,
        [...machines].map(([id, machine]) => ({ id, ...machine })),
      );
    }
    if (method === 'POST' && url.pathname === '/v1/remote/machines') {
      const body = JSON.parse(String(init?.body)) as Record<string, string>;
      if (!options.describes && Object.keys(body).some((key) => key !== 'name')) {
        return json(400, { error: 'Unrecognized key' });
      }
      made += 1;
      const id = `machine-${made}`;
      const token = `worker-token-${made}-synthetic`;
      machines.set(id, { name: body.name ?? '', platform: body.platform, token });
      return json(201, { id, name: body.name, token });
    }
    const rotate = /^\/v1\/remote\/machines\/([^/]+)\/rotate$/.exec(url.pathname);
    if (method === 'POST' && rotate) {
      const machine = machines.get(rotate[1] ?? '');
      if (!machine) return json(404, { error: 'Remote machine not found' });
      machine.token = `${machine.token}-rotated`;
      return json(200, { id: rotate[1], token: machine.token });
    }
    return json(404, { error: 'Not found' });
  };
  return { machines, requests, fetch: fetch as typeof globalThis.fetch, made: () => made };
}

function memoryEntries(initial: Record<string, MachineEntry> = {}): MachineEntries & {
  all: Map<string, MachineEntry>;
} {
  const all = new Map(Object.entries(initial));
  return {
    all,
    get: (id) => all.get(id),
    set: async (id, entry) => {
      all.set(id, entry);
    },
    delete: async (id) => {
      all.delete(id);
    },
  };
}

const registryFor = (gateway: ReturnType<typeof fakeGateway>, entries: MachineEntries) =>
  new MachineRegistry({ entries, fetch: gateway.fetch, identity: async () => identity });

describe('registering this computer on a gateway', () => {
  it('creates a machine named after the computer, with its platform and system', async () => {
    const gateway = fakeGateway({ describes: true });
    const entries = memoryEntries();
    const entry = await registryFor(gateway, entries).ensure(server);

    expect(entry).toEqual({ machineId: 'machine-1', token: 'worker-token-1-synthetic' });
    expect(gateway.machines.get('machine-1')).toMatchObject({
      name: 'Studio Mac',
      platform: 'darwin-arm64',
    });
    expect(entries.get('gw-1')).toEqual(entry);
  });

  it('still registers on a gateway that only knows the machine’s name', async () => {
    const gateway = fakeGateway({ describes: false });
    const entry = await registryFor(gateway, memoryEntries()).ensure(server);

    expect(entry?.machineId).toBe('machine-1');
    expect(gateway.machines.get('machine-1')?.name).toBe('Studio Mac');
  });

  it('reuses the machine it registered before while the gateway lists it and takes its token', async () => {
    const gateway = fakeGateway();
    gateway.machines.set('machine-7', { name: 'Studio Mac', token: 'worker-token-7-synthetic' });
    const entries = memoryEntries({
      'gw-1': { machineId: 'machine-7', token: 'worker-token-7-synthetic' },
    });
    const entry = await registryFor(gateway, entries).ensure(server);

    expect(entry).toEqual({ machineId: 'machine-7', token: 'worker-token-7-synthetic' });
    expect(gateway.made()).toBe(0);
    expect(gateway.machines.size).toBe(1);
  });

  it('creates a new machine when the owner removed the one it had', async () => {
    const gateway = fakeGateway();
    const entries = memoryEntries({
      'gw-1': { machineId: 'machine-gone', token: 'worker-token-gone-synthetic' },
    });
    const entry = await registryFor(gateway, entries).ensure(server);

    expect(entry?.machineId).toBe('machine-1');
    expect(entries.get('gw-1')?.machineId).toBe('machine-1');
  });

  it('rotates the worker token the gateway refuses, keeping the same machine', async () => {
    const gateway = fakeGateway();
    gateway.machines.set('machine-7', { name: 'Studio Mac', token: 'worker-token-new-synthetic' });
    const entries = memoryEntries({
      'gw-1': { machineId: 'machine-7', token: 'worker-token-old-synthetic' },
    });
    const entry = await registryFor(gateway, entries).ensure(server);

    expect(entry).toEqual({ machineId: 'machine-7', token: 'worker-token-new-synthetic-rotated' });
    expect(entries.get('gw-1')).toEqual(entry);
    expect(gateway.made()).toBe(0);
  });

  it('never registers on the app’s own gateway', async () => {
    const gateway = fakeGateway();
    const entries = memoryEntries();
    const entry = await registryFor(gateway, entries).ensure(local);

    expect(entry).toBeUndefined();
    expect(gateway.requests).toEqual([]);
    expect(entries.all.size).toBe(0);
  });

  it('creates one machine when asked several times at once', async () => {
    const gateway = fakeGateway();
    const registry = registryFor(gateway, memoryEntries());
    const entries = await Promise.all([
      registry.ensure(server),
      registry.ensure(server),
      registry.ensure(server),
    ]);

    expect(gateway.made()).toBe(1);
    expect(new Set(entries.map((entry) => entry?.machineId))).toEqual(new Set(['machine-1']));
  });

  it('keeps nothing for a gateway forgotten while it registered', async () => {
    const gateway = fakeGateway();
    const entries = memoryEntries();
    const registry = registryFor(gateway, entries);
    const registering = registry.ensure(server);
    await registry.forget('gw-1');

    expect(await registering).toBeUndefined();
    expect(entries.all.size).toBe(0);
  });

  it('fails without keeping anything when the gateway refuses the host token', async () => {
    const gateway = fakeGateway();
    const entries = memoryEntries();
    const refused = registryFor(gateway, entries).ensure({ ...server, token: 'wrong-token' });

    await expect(refused).rejects.toThrow(/401/);
    expect(entries.all.size).toBe(0);
  });
});

/** Records which workers run, by gateway. */
function recordingHost(): WorkerHost & { running: Map<string, WorkerTarget> } {
  const running = new Map<string, WorkerTarget>();
  return {
    running,
    start: (id, target) => {
      running.set(id, target);
    },
    stop: (id) => {
      running.delete(id);
    },
    stopAll: async () => {
      running.clear();
    },
  };
}

function sharingWith(gateways: { gateway: GatewayAccess; online: boolean }[], on = true) {
  const gateway = fakeGateway();
  const host = recordingHost();
  let sharing = on;
  const computer = new ComputerSharing({
    registry: registryFor(gateway, memoryEntries()),
    host,
    setting: {
      sharing: () => sharing,
      setSharing: async (value) => {
        sharing = value;
      },
    },
    gateways: () => gateways,
    changed: () => {},
    log: () => {},
    loaded: Promise.resolve(),
  });
  return { computer, host, gateway };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

describe('this computer’s workers', () => {
  it('run for every server gateway that answers, never for the app’s own', async () => {
    const { computer, host, gateway } = sharingWith([
      { gateway: local, online: true },
      { gateway: server, online: true },
    ]);
    computer.sync();
    await settle();

    expect([...host.running.keys()]).toEqual(['gw-1']);
    expect(host.running.get('gw-1')).toMatchObject({
      gateway: 'https://jian.example.com',
      machineId: 'machine-1',
    });
    expect(gateway.requests.every((request) => !request.includes('127.0.0.1'))).toBe(true);
    expect(computer.state('local').machineId).toBeNull();
    expect(computer.state('gw-1')).toEqual({ machineId: 'machine-1', sharing: true });
  });

  it('wait while a gateway does not answer', async () => {
    const { computer, host, gateway } = sharingWith([{ gateway: server, online: false }]);
    computer.sync();
    await settle();

    expect(host.running.size).toBe(0);
    expect(gateway.requests).toEqual([]);
  });

  it('all stop when the switch goes off, and the machines stay on the gateways', async () => {
    const { computer, host, gateway } = sharingWith([{ gateway: server, online: true }]);
    computer.sync();
    await settle();
    await computer.setSharing(false);

    expect(host.running.size).toBe(0);
    expect(gateway.machines.size).toBe(1);
    expect(computer.state('gw-1')).toEqual({ machineId: 'machine-1', sharing: false });
  });

  it('start again on a new token when the gateway refused the old one', async () => {
    const { computer, host, gateway } = sharingWith([{ gateway: server, online: true }]);
    computer.sync();
    await settle();
    const machine = gateway.machines.get('machine-1');
    if (machine) machine.token = 'worker-token-owner-rotated-synthetic';
    computer.refused('gw-1');
    await settle();

    expect(host.running.get('gw-1')).toMatchObject({
      machineId: 'machine-1',
      token: 'worker-token-owner-rotated-synthetic-rotated',
    });
  });
});

describe('what this computer is called', () => {
  it('is the Mac’s name from its settings, not its network name', () => {
    expect(
      computerName({
        platform: 'darwin',
        hostname: 'Studio-Mac.local',
        env: {},
        macName: 'Ada’s Studio Mac\n',
      }),
    ).toBe('Ada’s Studio Mac');
  });

  it('is COMPUTERNAME on Windows', () => {
    expect(
      computerName({ platform: 'win32', hostname: 'desk-01', env: { COMPUTERNAME: 'DESK-01' } }),
    ).toBe('DESK-01');
  });

  it('is the host name without .local elsewhere, or when the system does not say', () => {
    expect(computerName({ platform: 'linux', hostname: 'workbench.local', env: {} })).toBe(
      'workbench',
    );
    expect(computerName({ platform: 'darwin', hostname: 'Studio-Mac.local', env: {} })).toBe(
      'Studio-Mac',
    );
    expect(computerName({ platform: 'linux', hostname: '', env: {} })).toBe('This computer');
  });

  it('fits the 80 characters a gateway keeps', () => {
    const name = computerName({ platform: 'linux', hostname: 'x'.repeat(200), env: {} });
    expect(name).toHaveLength(80);
  });
});
