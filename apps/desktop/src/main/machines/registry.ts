import type { ComputerIdentity } from './identity';

/** This computer's machine on one gateway, and the worker token that answers for it there. */
export type MachineEntry = { machineId: string; token: string };

/** Where the entries are kept between launches; the app seals the worker tokens. */
export interface MachineEntries {
  get(gatewayId: string): MachineEntry | undefined;
  set(gatewayId: string, entry: MachineEntry): Promise<void>;
  delete(gatewayId: string): Promise<void>;
}

/** A gateway as registration needs it: where it answers and the host token that signs for it. */
export type GatewayAccess = { id: string; url: string; local?: boolean; token: string };

/** Registration could not finish: the gateway answered with something it cannot go on from. */
class RegistrationError extends Error {}

/**
 * Makes sure this computer is a machine on each server gateway, with a worker token that works:
 * the one kept from before while the gateway still lists it and accepts its token, a rotated
 * token when it refuses it, a new machine when the owner removed the old one. The app's own
 * gateway is never one: it runs on this computer already, and only chats.
 */
export class MachineRegistry {
  /** One registration at a time per gateway: two at once would create two machines. */
  private readonly pending = new Map<string, Promise<MachineEntry | undefined>>();
  /** Moves on when a gateway is forgotten, so a registration already under way keeps nothing. */
  private readonly generations = new Map<string, number>();

  constructor(
    private readonly deps: {
      entries: MachineEntries;
      fetch: typeof fetch;
      identity: () => Promise<ComputerIdentity>;
    },
  ) {}

  /** The machine this computer is on the gateway, as last registered; null until it is. */
  machineId(gatewayId: string): string | null {
    return this.deps.entries.get(gatewayId)?.machineId ?? null;
  }

  /**
   * This computer's machine on the gateway, ready for its worker; undefined for the app's own
   * gateway, and for one forgotten while it registered. Throws when the gateway did not let it
   * register, which a later call tries again.
   */
  ensure(gateway: GatewayAccess): Promise<MachineEntry | undefined> {
    if (gateway.local) return Promise.resolve(undefined);
    const running = this.pending.get(gateway.id);
    if (running) return running;
    const task: Promise<MachineEntry | undefined> = this.register(gateway).finally(() => {
      if (this.pending.get(gateway.id) === task) this.pending.delete(gateway.id);
    });
    this.pending.set(gateway.id, task);
    return task;
  }

  /** The gateway left the app: its entry goes. The machine stays on the gateway for its owner. */
  async forget(gatewayId: string): Promise<void> {
    this.generations.set(gatewayId, (this.generations.get(gatewayId) ?? 0) + 1);
    this.pending.delete(gatewayId);
    await this.deps.entries.delete(gatewayId);
  }

  private async register(gateway: GatewayAccess): Promise<MachineEntry | undefined> {
    const generation = this.generations.get(gateway.id) ?? 0;
    const keep = async (entry: MachineEntry) => {
      if ((this.generations.get(gateway.id) ?? 0) !== generation) return undefined;
      await this.deps.entries.set(gateway.id, entry);
      return entry;
    };

    const saved = this.deps.entries.get(gateway.id);
    if (saved && (await this.listed(gateway, saved.machineId))) {
      // The disconnect route is the one a worker may call that changes nothing a stopped worker
      // would not: it is asked before the worker starts, so marking it offline costs nothing.
      const check = await this.request(gateway, 'POST', workerPath(saved, 'disconnect'), {
        token: saved.token,
      });
      if (check.ok) return keep(saved);
      if (check.status !== 401) throw refused('checking the worker token', check);
      const rotated = await this.request(gateway, 'POST', machinePath(saved, 'rotate'));
      if (rotated.ok) return keep(await created(rotated));
      // Removed between the list and the rotation: it is made again below.
      if (rotated.status !== 404) throw refused('rotating the worker token', rotated);
    }

    const identity = await this.deps.identity();
    let made = await this.request(gateway, 'POST', '/v1/remote/machines', { body: identity });
    // A gateway from before a creator could describe its machine knows only the name; the
    // worker's first poll tells it the platform anyway.
    if (made.status === 400) {
      made = await this.request(gateway, 'POST', '/v1/remote/machines', {
        body: { name: identity.name },
      });
    }
    if (!made.ok) throw refused('creating the machine', made);
    return keep(await created(made));
  }

  private async listed(gateway: GatewayAccess, machineId: string): Promise<boolean> {
    const response = await this.request(gateway, 'GET', '/v1/remote/machines');
    if (!response.ok) throw refused('listing machines', response);
    const machines: unknown = await response.json();
    return (
      Array.isArray(machines) &&
      machines.some((machine: { id?: unknown }) => machine?.id === machineId)
    );
  }

  /** Signed with the host token unless a worker token is given; JSON both ways. */
  private request(
    gateway: GatewayAccess,
    method: 'GET' | 'POST',
    path: string,
    options: { token?: string; body?: unknown } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${options.token ?? gateway.token}`,
    };
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    return this.deps.fetch(`${gateway.url}${path}`, {
      method,
      headers,
      redirect: 'error',
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
  }
}

const machinePath = (entry: MachineEntry, action: string) =>
  `/v1/remote/machines/${encodeURIComponent(entry.machineId)}/${action}`;
const workerPath = (entry: MachineEntry, action: string) =>
  `/v1/remote/worker/${encodeURIComponent(entry.machineId)}/${action}`;

const refused = (step: string, response: Response) =>
  new RegistrationError(`The gateway answered ${response.status} ${step}.`);

/** A created or rotated machine, as the gateway hands it over once: its id and worker token. */
async function created(response: Response): Promise<MachineEntry> {
  const body = (await response.json()) as { id?: unknown; token?: unknown } | null;
  if (typeof body?.id !== 'string' || typeof body.token !== 'string' || !body.token) {
    throw new RegistrationError('The gateway did not hand over the machine’s worker token.');
  }
  return { machineId: body.id, token: body.token };
}
