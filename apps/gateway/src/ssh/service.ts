import {
  createHash,
  generateKeyPairSync,
  type KeyObject,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { chmod, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SshKey, SshKeyCreate } from '@jian/contracts';
import { asc, eq } from 'drizzle-orm';
import { assertFound } from '../core/errors.js';
import { GATEWAY_SCOPE, type GatewayVault } from '../security/gateway-vault.js';
import type { Store } from '../storage/database.js';
import { sshKeys } from '../storage/schema.js';

/** Where a workspace keeps the installation's keys, one directory per key id. */
export const directory = (home: string) => join(home, '.ssh', 'jian');

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
 * The installation's SSH keys, shared by every agent. PostgreSQL holds them, so a backup carries
 * them; the private half is encrypted in the gateway vault and reaches a workspace only as the
 * file `git` reads, written by `sync` when a run starts.
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
    return this.store.transaction(GATEWAY_SCOPE, async (tx) => {
      const [row] = await tx
        .delete(sshKeys)
        .where(eq(sshKeys.id, id))
        .returning({ id: sshKeys.id });
      assertFound(row, 'SSH key');
      await this.vault.discard(sshKeySecret(id), tx);

      return { id };
    });
  }

  /**
   * Makes a workspace hold exactly the installation's keys under `~/.ssh/jian/<id>/`, where the
   * ssh wrapper and GIT_SSH_COMMAND look. A key removed since the last run leaves with its
   * directory; anything not named by a key id is left alone.
   */
  async sync(home: string): Promise<void> {
    const root = directory(home);
    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);

    const keys = await this.list();
    const kept = new Set(keys.map((key) => key.id));

    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.isDirectory() && KEY_ID.test(entry.name) && !kept.has(entry.name)) {
        await rm(join(root, entry.name), { recursive: true, force: true });
      }
    }

    for (const key of keys) {
      const privateKey = await this.vault.read(sshKeySecret(key.id));
      // A row without its secret is a key half-removed by hand; it has nothing to write.
      if (!privateKey) continue;

      const target = join(root, key.id);
      await mkdir(target, { recursive: true, mode: 0o700 });
      await chmod(target, 0o700);
      await writeFile(join(target, 'id_ed25519'), privateKey, { mode: 0o600 });
      await chmod(join(target, 'id_ed25519'), 0o600);
      await writeFile(join(target, 'id_ed25519.pub'), `${key.publicKey}\n`, { mode: 0o644 });
    }
  }
}
