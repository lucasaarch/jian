import type { GatewayAccess, MachineEntry, MachineRegistry } from './registry';

/** What a worker needs to reach its gateway as this computer's machine there. */
export type WorkerTarget = { gateway: string; machineId: string; token: string };

/** Where the workers run: the app keeps them out of its main process. */
export interface WorkerHost {
  start(gatewayId: string, target: WorkerTarget): void;
  stop(gatewayId: string): void;
  /** Every worker says goodbye to its gateway; resolves once they have, or gave up. */
  stopAll(): Promise<void>;
}

/** Where the computer-wide switch is kept. */
export interface SharingSetting {
  sharing(): boolean;
  setSharing(on: boolean): Promise<void>;
}

/** A gateway the app knows, and whether it answers now. */
export type GatewayStanding = { gateway: GatewayAccess; online: boolean };

/** How long a gateway that could not register, or refused a fresh token, waits to try again, in ms. */
const RETRY_MS = 60_000;

/**
 * This computer as a machine on every server gateway the app knows: registered and its worker
 * running while the computer-wide switch is on and the gateway answers; stopped when the switch
 * goes off, the gateway goes away or leaves the app. The records stay on the gateways.
 */
export class ComputerSharing {
  /** Each gateway with a worker starting or running; the object itself tells one start apart. */
  private readonly runs = new Map<string, { entry?: MachineEntry }>();
  /** When a gateway last could not register, or refused a token just handed out. */
  private readonly setbacks = new Map<string, number>();
  /** When each gateway last refused its worker's token. */
  private readonly refusals = new Map<string, number>();
  private retry?: ReturnType<typeof setTimeout>;
  /** Nothing runs before the switch and the saved machines are read. */
  private ready = false;

  constructor(
    private readonly deps: {
      registry: MachineRegistry;
      host: WorkerHost;
      setting: SharingSetting;
      gateways: () => GatewayStanding[];
      /** A machine id or the switch changed: the window asks again. */
      changed: () => void;
      log: (message: string) => void;
      /** Resolves once the switch and the saved machines are read. */
      loaded: Promise<void>;
      now?: () => number;
    },
  ) {
    void deps.loaded.then(() => {
      this.ready = true;
      this.deps.changed();
      this.sync();
    });
  }

  state(gatewayId: string): { machineId: string | null; sharing: boolean } {
    const local = this.deps.gateways().some((g) => g.gateway.id === gatewayId && g.gateway.local);
    return {
      machineId: local ? null : this.deps.registry.machineId(gatewayId),
      sharing: this.sharing(),
    };
  }

  /** The computer-wide switch: whether agents may use this computer. */
  sharing(): boolean {
    return this.deps.setting.sharing();
  }

  async setSharing(on: boolean): Promise<void> {
    // Written before the file was read, the switch would overwrite the machines saved there.
    await this.deps.loaded;
    if (this.deps.setting.sharing() === on) return;
    await this.deps.setting.setSharing(on);
    this.deps.changed();
    this.sync();
  }

  /** Brings the running workers in line with the switch and how each gateway stands. */
  sync(): void {
    if (!this.ready) return;
    const wanted = new Map<string, GatewayAccess>();
    if (this.deps.setting.sharing()) {
      for (const { gateway, online } of this.deps.gateways()) {
        if (online && !gateway.local && gateway.url) wanted.set(gateway.id, gateway);
      }
    }
    for (const id of [...this.runs.keys()]) {
      if (!wanted.has(id)) this.halt(id);
    }
    for (const [id, gateway] of wanted) {
      if (this.runs.has(id) || this.waiting(id)) continue;
      void this.start(gateway);
    }
  }

  /**
   * The gateway refused the worker's token: the owner rotated it from the panel, or removed the
   * machine. Registered again at once, which rotates or recreates it; if the fresh one is
   * refused too, not again for a while.
   */
  refused(gatewayId: string): void {
    if (!this.runs.has(gatewayId)) return;
    this.halt(gatewayId);
    this.deps.log(`The gateway ${gatewayId} refused this computer's worker token.`);
    const last = this.refusals.get(gatewayId);
    this.refusals.set(gatewayId, this.now());
    if (last !== undefined && this.now() - last < RETRY_MS) {
      this.setbacks.set(gatewayId, this.now());
      this.later();
      return;
    }
    this.sync();
  }

  /** The gateway left the app: its worker stops and its entry goes. */
  async forget(gatewayId: string): Promise<void> {
    await this.deps.loaded;
    this.halt(gatewayId);
    this.setbacks.delete(gatewayId);
    this.refusals.delete(gatewayId);
    await this.deps.registry.forget(gatewayId);
    this.deps.changed();
  }

  /** The app quits: every worker says goodbye first. */
  async stopAll(): Promise<void> {
    clearTimeout(this.retry);
    this.runs.clear();
    await this.deps.host.stopAll();
  }

  private async start(gateway: GatewayAccess): Promise<void> {
    const run: { entry?: MachineEntry } = {};
    this.runs.set(gateway.id, run);
    const before = this.deps.registry.machineId(gateway.id);
    let entry: MachineEntry | undefined;
    try {
      entry = await this.deps.registry.ensure(gateway);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.deps.log(`This computer could not register on ${gateway.url}: ${reason}`);
      this.setbacks.set(gateway.id, this.now());
    }
    // Stopped, or started again, while it registered: that later decision stands.
    if (this.runs.get(gateway.id) !== run) return;
    if (!entry) {
      this.runs.delete(gateway.id);
      this.later();
      return;
    }
    run.entry = entry;
    this.deps.host.start(gateway.id, { gateway: gateway.url, ...entry });
    if (entry.machineId !== before) this.deps.changed();
  }

  private halt(gatewayId: string): void {
    const run = this.runs.get(gatewayId);
    if (!run) return;
    this.runs.delete(gatewayId);
    if (run.entry) this.deps.host.stop(gatewayId);
  }

  private waiting(gatewayId: string): boolean {
    const at = this.setbacks.get(gatewayId);
    return at !== undefined && this.now() - at < RETRY_MS;
  }

  private later(): void {
    if (this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = undefined;
      this.sync();
    }, RETRY_MS);
    this.retry.unref?.();
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
}
