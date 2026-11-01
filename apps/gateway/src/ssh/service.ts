import {
  createHash,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SshKey, SshKeyCreate } from '@jian/contracts';
import { asc, eq } from 'drizzle-orm';
import { assertFound } from '../core/errors.js';
import { GATEWAY_SCOPE, type GatewayVault } from '../security/gateway-vault.js';
import type { Store } from '../storage/database.js';
import { sshKeys } from '../storage/schema.js';
import { earlierKeyDirectories, keysDirectory } from './keys-directory.js';

const uint32 = (value: number) => {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value);
  return buffer;
};

const sshString = (value: Buffer | string) => {
  const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([uint32(data.length), data]);
};

function sshPublicKey(key: KeyObject, name: string) {
  const raw = key.export({ type: 'spki', format: 'der' }).subarray(-32);
  const type = Buffer.from('ssh-ed25519');
  const blob = Buffer.concat([uint32(type.length), type, uint32(raw.length), raw]);
  const value = `ssh-ed25519 ${blob.toString('base64')} jian-${name.replace(/[^a-zA-Z0-9_-]+/g, '-')}`;
  const fingerprint = `SHA256/${createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
  return { value, fingerprint, blob, raw };
}

/** OpenSSH does not read PKCS#8 PEM files as identities; write its native envelope instead. */
function openSshPrivateKey(privateKey: KeyObject, publicKey: ReturnType<typeof sshPublicKey>) {
  const seed = privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32);
  const check = randomBytes(4);
  const body = Buffer.concat([
    check,
    check,
    sshString('ssh-ed25519'),
    sshString(publicKey.raw),
    sshString(Buffer.concat([seed, publicKey.raw])),
    sshString(''),
  ]);
  const padding = Buffer.from(
    Array.from({ length: (8 - (body.length % 8)) % 8 || 8 }, (_, index) => index + 1),
  );
  const payload = Buffer.concat([
    Buffer.from('openssh-key-v1\0'),
    sshString('none'),
    sshString('none'),
    sshString(''),
    uint32(1),
    sshString(publicKey.blob),
    sshString(Buffer.concat([body, padding])),
  ]).toString('base64');
  return `-----BEGIN OPENSSH PRIVATE KEY-----\n${payload.match(/.{1,70}/g)?.join('\n')}\n-----END OPENSSH PRIVATE KEY-----\n`;
}

/** Where a key's private half lives in the gateway vault. */
export const sshKeySecret = (id: string) => `ssh-key:${id}`;

const KEY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const recordOf = (row: typeof sshKeys.$inferSelect): SshKey => ({
  id: row.id,
  name: row.name,
  publicKey: row.publicKey,
  fingerprint: row.fingerprint,
  createdAt: row.createdAt.toISOString(),
});

/**
 * Replaced in one step, and only when it differs: every run of every agent syncs the same files,
 * and a key truncated for a moment fails the `git` another agent is running right then.
 */
async function writeInOneStep(path: string, content: string, mode: number): Promise<void> {
  if ((await readFile(path, 'utf8').catch(() => undefined)) !== content) {
    const incoming = `${path}.${randomBytes(6).toString('hex')}`;

    await writeFile(incoming, content, { mode });
    await rename(incoming, path);
  }
  await chmod(path, mode);
}

/**
 * The installation's SSH keys, shared by every agent. PostgreSQL holds them, so a backup carries
 * them; the private half is encrypted in the gateway vault and reaches the disk only as the file
 * `git` reads, written by `sync` when a run starts.
 */
export class SshKeys {
  constructor(
    private readonly store: Store,
    private readonly vault: GatewayVault,
  ) {}

  async list(): Promise<SshKey[]> {
    const rows = await this.store.db.select().from(sshKeys).orderBy(asc(sshKeys.createdAt));

    return rows.map(recordOf);
  }

  async create(input: SshKeyCreate): Promise<SshKey> {
    const pair = generateKeyPairSync('ed25519') as { publicKey: KeyObject; privateKey: KeyObject };
    const key = sshPublicKey(pair.publicKey, input.name);
    const id = randomUUID();

    return this.store.transaction(GATEWAY_SCOPE, async (tx) => {
      const [row] = await tx
        .insert(sshKeys)
        .values({ id, name: input.name, publicKey: key.value, fingerprint: key.fingerprint })
        .returning();
      await this.vault.put(sshKeySecret(id), openSshPrivateKey(pair.privateKey, key), tx);

      return recordOf(assertFound(row, 'SSH key'));
    });
  }

  async remove(id: string): Promise<{ id: string }> {
    const removed = await this.store.transaction(GATEWAY_SCOPE, async (tx) => {
      const [row] = await tx
        .delete(sshKeys)
        .where(eq(sshKeys.id, id))
        .returning({ id: sshKeys.id });
      assertFound(row, 'SSH key');
      await this.vault.discard(sshKeySecret(id), tx);

      return { id };
    });

    // It is gone from the table now, so a failure here is no failure to remove: the next run retries.
    await this.prune().catch(() => {});

    return removed;
  }

  /**
   * Takes every key no longer listed off the disk, wherever a version of Jian wrote it; anything
   * not named by a key id is left alone. The per-profile folders of earlier versions count: no run
   * writes there now, but every agent can read them, and a key left there with its metadata would
   * be imported again at the next start, undoing the removal.
   */
  private async prune(): Promise<void> {
    const kept = new Set((await this.list()).map((key) => key.id));

    for (const root of [await keysDirectory(), ...(await earlierKeyDirectories())]) {
      for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
        if (entry.isDirectory() && KEY_ID.test(entry.name) && !kept.has(entry.name)) {
          await rm(join(root, entry.name), { recursive: true, force: true });
        }
      }
    }
  }

  /**
   * Makes this host's key folder hold exactly the installation's keys under `<id>/`, where
   * GIT_SSH_COMMAND looks and, on a server, the ssh wrapper too. A key removed since the last run
   * leaves with its directory.
   */
  async sync(): Promise<void> {
    const root = await keysDirectory();
    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
    await this.prune();

    for (const key of await this.list()) {
      const privateKey = await this.vault.read(sshKeySecret(key.id));
      // A row without its secret is a key half-removed by hand; it has nothing to write.
      if (!privateKey) continue;

      const target = join(root, key.id);
      await mkdir(target, { recursive: true, mode: 0o700 });
      await chmod(target, 0o700);
      await writeInOneStep(join(target, 'id_ed25519'), privateKey, 0o600);
      await writeInOneStep(join(target, 'id_ed25519.pub'), `${key.publicKey}\n`, 0o644);
    }
  }
}
