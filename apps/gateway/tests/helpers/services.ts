import { randomBytes } from 'node:crypto';
import type { ModelCatalog } from '../../src/providers/catalog-source.js';
import { SecretBox } from '../../src/security/crypto.js';
import { GatewayVault } from '../../src/security/gateway-vault.js';
import { Vault } from '../../src/security/vault.js';
import { buildServices, type Services } from '../../src/services.js';
import { TestStore } from './database.js';

/** A synthetic keyring per call: tests exercise the real encryption path, never a stub. */
export async function testServices(
  clock?: () => number,
  catalog?: ModelCatalog,
  timeZone?: string,
): Promise<Services & { store: TestStore }> {
  const store = await TestStore.create();
  const box = new SecretBox({ activeKeyId: 'test', keys: { test: randomBytes(32) } });
  const services = buildServices({
    store,
    vault: new Vault(store, box, clock),
    gatewayVault: new GatewayVault(store, box, clock),
    clock,
    catalog,
    ...(timeZone ? { timeZone } : {}),
  });
  const createProfile = services.profiles.createProfile.bind(services.profiles);
  // Gateway execution tests use an ordinary developer profile unless they explicitly declare
  // professionId: null to cover the legacy, unclassified hold behavior.
  services.profiles.createProfile = (input: unknown) =>
    createProfile(
      input && typeof input === 'object' && !Object.hasOwn(input, 'professionId')
        ? { ...input, professionId: 'developer' }
        : input,
    );

  const submitRun = services.runs.submit.bind(services.runs);
  services.runs.submit = (profileId, sessionId, input, options) =>
    submitRun(profileId, sessionId, input, {
      ...options,
      ...(options?.ownerMessage === undefined &&
      !options?.systemTask &&
      !options?.authorityFrom &&
      !options?.call &&
      !options?.subagent &&
      !options?.continuationOf
        ? { ownerMessage: true }
        : {}),
    });

  return { ...services, store };
}
