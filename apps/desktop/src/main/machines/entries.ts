import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app } from 'electron';
import { seal, unseal, VAULT_MISSING, vaultAvailable } from '../gateways/store';
import type { MachineEntries, MachineEntry } from './registry';
import type { SharingSetting } from './sharing';

type Saved = {
  /** The computer-wide switch: whether agents on the app's server gateways may use it. */
  sharing: boolean;
  /** By gateway id: this computer's machine there, its worker token sealed as host tokens are. */
  machines: Record<string, { machineId: string; sealedToken: string }>;
};

const file = () => join(app.getPath('userData'), 'machines.json');

/**
 * How long opening one sealed token may take, in ms. The vault can wait on the owner (a keychain
 * prompt) or stall; a token not opened in time reads as refused, and registering rotates it.
 */
const UNSEAL_MS = 10_000;

const unsealInTime = (sealed: string) =>
  Promise.race([
    unseal(sealed),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('The vault did not open the token in time.')), UNSEAL_MS),
    ),
  ]);

/**
 * This computer as a machine on the app's gateways, kept in userData beside the gateways: the
 * switch, on until the owner turns it off, and each machine's worker token, sealed by the
 * operating system's vault, opened once on load and held in memory.
 */
export class MachineFile implements MachineEntries, SharingSetting {
  private saved: Saved = { sharing: true, machines: {} };
  private readonly tokens = new Map<string, string>();
  private writing: Promise<void> = Promise.resolve();

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(file(), 'utf8')) as Partial<Saved> | null;
      this.saved = {
        sharing: parsed?.sharing !== false,
        machines: typeof parsed?.machines === 'object' && parsed.machines ? parsed.machines : {},
      };
    } catch {
      this.saved = { sharing: true, machines: {} };
    }
    let resealed = false;
    for (const [gatewayId, machine] of Object.entries(this.saved.machines)) {
      try {
        const { result, shouldReEncrypt } = await unsealInTime(machine.sealedToken);
        this.tokens.set(gatewayId, result);
        if (shouldReEncrypt) {
          machine.sealedToken = await seal(result);
          resealed = true;
        }
      } catch {
        // A token this keychain cannot open is refused by the gateway; registering rotates it.
        this.tokens.set(gatewayId, '');
      }
    }
    if (resealed) await this.save();
  }

  sharing(): boolean {
    return this.saved.sharing;
  }

  async setSharing(on: boolean): Promise<void> {
    this.saved.sharing = on;
    await this.save();
  }

  get(gatewayId: string): MachineEntry | undefined {
    const machine = this.saved.machines[gatewayId];
    return machine
      ? { machineId: machine.machineId, token: this.tokens.get(gatewayId) ?? '' }
      : undefined;
  }

  async set(gatewayId: string, entry: MachineEntry): Promise<void> {
    if (!(await vaultAvailable())) throw new Error(VAULT_MISSING);
    const sealedToken = await seal(entry.token);
    this.tokens.set(gatewayId, entry.token);
    this.saved.machines = {
      ...this.saved.machines,
      [gatewayId]: { machineId: entry.machineId, sealedToken },
    };
    await this.save();
  }

  async delete(gatewayId: string): Promise<void> {
    if (!(gatewayId in this.saved.machines)) return;
    this.tokens.delete(gatewayId);
    const machines = { ...this.saved.machines };
    delete machines[gatewayId];
    this.saved.machines = machines;
    await this.save();
  }

  /**
   * Written beside, then renamed over, so a crash mid-write never loses a token; one write at a
   * time, as gateways register side by side and would otherwise share the file beside.
   */
  private save(): Promise<void> {
    const write = async () => {
      const temporary = `${file()}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(this.saved, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, file());
    };
    const next = this.writing.then(write, write);
    this.writing = next.catch(() => undefined);
    return next;
  }
}
