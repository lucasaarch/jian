import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app, safeStorage } from 'electron';
import { LOCAL_GATEWAY_ID } from '../../shared/bridge';

/** A gateway as this computer keeps it: the token sealed by the operating system's vault. */
export type StoredGateway = {
  id: string;
  /** The app's own gateway, kept in memory: its address changes every launch. */
  local?: true;
  name: string;
  url: string;
  /** The host token, encrypted with safeStorage and base64-encoded. */
  sealedToken: string;
  addedAt: string;
};

const file = () => join(app.getPath('userData'), 'gateways.json');

/**
 * Whether tokens can be kept safely here. On Linux without a keyring, safeStorage would fall back
 * to a fixed key, which protects nothing: the app refuses to store a token rather than pretend.
 */
export async function vaultAvailable(): Promise<boolean> {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) return false;
  return process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text';
}

export const VAULT_MISSING =
  'This computer has no keyring to keep the gateway token in. Install and unlock one (GNOME Keyring or KWallet), then try again.';

export const seal = async (value: string) =>
  (await safeStorage.encryptStringAsync(value)).toString('base64');

/** The value, and whether the keychain asks for it to be sealed again under a newer key. */
export const unseal = (sealed: string) =>
  safeStorage.decryptStringAsync(Buffer.from(sealed, 'base64'));

/**
 * The gateways the owner connected, kept in userData, with their tokens opened once on load and
 * held in memory: every request the app forwards is signed without asking the keychain again.
 */
export class GatewayStore {
  private gateways: StoredGateway[] = [];
  private readonly tokens = new Map<string, string>();
  private own?: StoredGateway;

  async load(): Promise<void> {
    try {
      const parsed: unknown = JSON.parse(await readFile(file(), 'utf8'));
      this.gateways = Array.isArray(parsed) ? (parsed as StoredGateway[]) : [];
    } catch {
      this.gateways = [];
    }
    let resealed = false;
    for (const gateway of this.gateways) {
      try {
        const { result, shouldReEncrypt } = await unseal(gateway.sealedToken);
        this.tokens.set(gateway.id, result);
        if (shouldReEncrypt) {
          gateway.sealedToken = await seal(result);
          resealed = true;
        }
      } catch {
        // A token this keychain cannot open reads as refused; the owner types it again.
      }
    }
    if (resealed) await this.save();
  }

  /** The app's own gateway, once it listens; an empty address while it starts or after it ended. */
  setLocal(url: string | undefined, token: string): void {
    this.tokens.set(LOCAL_GATEWAY_ID, token);
    this.own = {
      id: LOCAL_GATEWAY_ID,
      local: true,
      name: 'This computer',
      url: url ?? '',
      sealedToken: '',
      addedAt: '',
    };
  }

  /** The app's own gateway first, then the ones the owner connected, in the order they were. */
  list(): readonly StoredGateway[] {
    return this.own ? [this.own, ...this.gateways] : this.gateways;
  }

  get(id: string): StoredGateway | undefined {
    return this.list().find((gateway) => gateway.id === id);
  }

  token(gateway: StoredGateway): string {
    return this.tokens.get(gateway.id) ?? '';
  }

  async add(input: { name: string; url: string; token: string }): Promise<StoredGateway> {
    if (!(await vaultAvailable())) throw new Error(VAULT_MISSING);
    const gateway: StoredGateway = {
      id: randomUUID(),
      name: input.name,
      url: input.url,
      sealedToken: await seal(input.token),
      addedAt: new Date().toISOString(),
    };
    this.tokens.set(gateway.id, input.token);
    this.gateways = [...this.gateways, gateway];
    await this.save();
    return gateway;
  }

  async replaceToken(id: string, token: string): Promise<void> {
    if (!(await vaultAvailable())) throw new Error(VAULT_MISSING);
    const sealedToken = await seal(token);
    this.tokens.set(id, token);
    this.gateways = this.gateways.map((gateway) =>
      gateway.id === id ? { ...gateway, sealedToken } : gateway,
    );
    await this.save();
  }

  async rename(id: string, name: string): Promise<void> {
    this.gateways = this.gateways.map((gateway) =>
      gateway.id === id ? { ...gateway, name } : gateway,
    );
    await this.save();
  }

  async remove(id: string): Promise<void> {
    this.tokens.delete(id);
    this.gateways = this.gateways.filter((gateway) => gateway.id !== id);
    await this.save();
  }

  /** Written beside, then renamed over, so a crash mid-write never loses the list. */
  private async save(): Promise<void> {
    const temporary = `${file()}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.gateways, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, file());
  }
}
