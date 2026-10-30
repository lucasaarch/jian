import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app } from 'electron';
import { seal, unseal, vaultAvailable } from '../gateways/store';

/** What the local gateway is started with: the token the app signs with, and its master key. */
export type LocalCredentials = { token: string; masterKey: string };

type Stored = { sealed: boolean; token: string; masterKey: string };

const file = () => join(app.getPath('userData'), 'local-gateway.json');

/**
 * Made once, on the first launch, and kept sealed by the system's keychain. Without a keyring (a
 * bare Linux), they are kept in a file only this user can read: the database they open sits in
 * the same data directory with the same protection, so sealing them alone would add nothing.
 */
export async function localCredentials(): Promise<LocalCredentials> {
  let stored: Stored | undefined;
  try {
    stored = JSON.parse(await readFile(file(), 'utf8')) as Stored;
  } catch {
    stored = undefined;
  }

  if (stored) {
    if (!stored.sealed) return { token: stored.token, masterKey: stored.masterKey };
    const token = await unseal(stored.token);
    const masterKey = await unseal(stored.masterKey);
    const credentials = { token: token.result, masterKey: masterKey.result };
    // The keychain moved to a newer key: what it opened is sealed again under it.
    if (token.shouldReEncrypt || masterKey.shouldReEncrypt) await save(credentials);
    return credentials;
  }

  const credentials = {
    token: randomBytes(32).toString('base64url'),
    masterKey: randomBytes(32).toString('base64'),
  };
  await save(credentials);
  return credentials;
}

async function save(credentials: LocalCredentials): Promise<void> {
  const sealed = await vaultAvailable();
  const stored: Stored = sealed
    ? { sealed, token: await seal(credentials.token), masterKey: await seal(credentials.masterKey) }
    : { sealed, ...credentials };
  await writeFile(file(), `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
}
