import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { eq, or } from 'drizzle-orm';
import { workspacesRoot } from '../agent/workspace.js';
import { GATEWAY_SCOPE, type GatewayVault } from '../security/gateway-vault.js';
import type { Store } from '../storage/database.js';
import { sshKeys } from '../storage/schema.js';
import { directory, sshKeySecret } from './service.js';

type Metadata = { id?: unknown; name?: unknown; fingerprint?: unknown; createdAt?: unknown };

const children = async (path: string) => readdir(path, { withFileTypes: true }).catch(() => []);

/**
 * Keys made before they belonged to the installation lived only as files in one agent's
 * workspace, `~/.ssh/jian/<id>/`. This takes each into the table and the gateway vault under the
 * id it already had, once: a key already there — by id, or the same public key made in another
 * workspace — is skipped, so a second start imports nothing. The files stay; each run's sync
 * owns them from now on. Returns how many keys were imported.
 */
export async function importWorkspaceSshKeys(store: Store, vault: GatewayVault): Promise<number> {
  let imported = 0;

  for (const workspace of await children(workspacesRoot())) {
    if (!workspace.isDirectory()) continue;
    const root = directory(join(workspacesRoot(), workspace.name));

    for (const entry of await children(root)) {
      if (!entry.isDirectory()) continue;
      const folder = join(root, entry.name);
      const read = (file: string) => readFile(join(folder, file), 'utf8').catch(() => undefined);
      const [metadata, privateKey, publicKey] = await Promise.all([
        read('metadata.json'),
        read('id_ed25519'),
        read('id_ed25519.pub'),
      ]);
      // An entry an interrupted generation left behind was never listed, and is not now.
      if (!metadata || !privateKey?.includes('PRIVATE KEY') || !publicKey?.trim()) continue;

      let fields: Metadata;
      try {
        fields = JSON.parse(metadata) as Metadata;
      } catch {
        continue;
      }
      if (fields.id !== entry.name || typeof fields.name !== 'string') continue;

      const id = entry.name;
      const value = publicKey.trim();
      const createdAt = typeof fields.createdAt === 'string' ? new Date(fields.createdAt) : null;

      await store.transaction(GATEWAY_SCOPE, async (tx) => {
        const [known] = await tx
          .select({ id: sshKeys.id })
          .from(sshKeys)
          .where(or(eq(sshKeys.id, id), eq(sshKeys.publicKey, value)))
          .limit(1);
        if (known) return;

        await tx.insert(sshKeys).values({
          id,
          name: fields.name as string,
          publicKey: value,
          fingerprint: typeof fields.fingerprint === 'string' ? fields.fingerprint : '',
          ...(createdAt && !Number.isNaN(createdAt.getTime()) ? { createdAt } : {}),
        });
        await vault.put(sshKeySecret(id), privateKey, tx);
        imported += 1;
      });
    }
  }

  return imported;
}
