import { describe, expect, it } from 'vitest';
import { mcpValueSecret } from '../src/agent/mcp-connect.js';
import { providerSecret } from '../src/providers/service.js';
import { secrets } from '../src/storage/schema.js';
import { secretRow } from './helpers/rows.js';
import { testServices } from './helpers/services.js';

const model = { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' };

async function setup() {
  const services = await testServices();

  const profile = await services.profiles.createProfile({
    name: 'Test',
    instructions: 'Help.',
    model,
  });

  // A second profile that exists: a secret cannot be planted under one that does not.
  const other = await services.profiles.createProfile({
    name: 'Other',
    instructions: 'Help.',
    model,
  });

  return { services, profile, otherProfile: other.id };
}

describe('profile vault', () => {
  it('keeps the secret out of the record and refuses an envelope moved to another profile', async () => {
    const { services, profile, otherProfile } = await setup();
    const owner = providerSecret('11111111-1111-4111-8111-111111111111');

    await services.vault.put(profile.id, owner, 'synthetic-secret');

    const stored = await secretRow(services.store, profile.id, owner);

    if (!stored) {
      throw new Error('The vault must persist the secret it accepted');
    }

    expect(JSON.stringify(stored)).not.toContain('synthetic-secret');
    expect(await services.vault.read(profile.id, owner)).toBe('synthetic-secret');
    expect(await services.vault.read(otherProfile, owner)).toBeUndefined();

    // A stolen envelope replanted under another profile must not decrypt.
    await services.store.transaction(otherProfile, async (tx) => {
      await tx.insert(secrets).values({ ...stored, profileId: otherProfile });
    });

    await expect(services.vault.read(otherProfile, owner)).rejects.toThrow();
  });

  it('discards a provider key when the provider is revoked or replaced', async () => {
    const { services } = await setup();

    const first = await services.providers.createProvider({
      name: 'OpenAI',
      kind: 'openai',
      secret: 'synthetic-first-key',
    });

    expect(await services.gatewayVault.read(providerSecret(first.id))).toBe('synthetic-first-key');

    const second = await services.providers.createProvider({
      name: 'OpenAI',
      kind: 'openai',
      secret: 'synthetic-second-key',
    });

    expect(await services.gatewayVault.read(providerSecret(first.id))).toBeUndefined();

    await services.providers.revokeProvider(second.id);

    expect(await services.gatewayVault.read(providerSecret(second.id))).toBeUndefined();
  });

  it('stores an MCP token with its server and forgets it when the server goes', async () => {
    const { services, profile } = await setup();

    const server = {
      name: 'tracker',
      url: 'https://mcp.example.com/mcp',
      auth: 'headers' as const,
    };

    const header = mcpValueSecret('tracker', 'header', 'Authorization');

    const updated = await services.profiles.updateProfile(profile.id, {
      expectedVersion: profile.version,
      mcpServers: [
        { ...server, headers: [{ name: 'Authorization', value: 'Basic synthetic-mcp-token' }] },
      ],
    });

    expect(JSON.stringify(updated)).not.toContain('synthetic-mcp-token');
    expect(await services.vault.read(profile.id, header)).toBe('Basic synthetic-mcp-token');

    // A patch that omits the value keeps the stored one, which is how an owner edits a server
    // without retyping a credential the panel can no longer show them.
    const kept = await services.profiles.updateProfile(profile.id, {
      expectedVersion: updated.version,
      mcpServers: [{ ...server, headers: [{ name: 'Authorization' }] }],
    });

    expect(await services.vault.read(profile.id, header)).toBe('Basic synthetic-mcp-token');

    // Removing the header removes its secret, even with the server still configured.
    const bare = await services.profiles.updateProfile(profile.id, {
      expectedVersion: kept.version,
      mcpServers: [{ ...server, auth: 'none' as const, headers: [] }],
    });

    expect(await services.vault.read(profile.id, header)).toBeUndefined();

    await services.profiles.updateProfile(profile.id, {
      expectedVersion: bare.version,
      mcpServers: [],
    });
  });
});
