import { expect, it } from 'vitest';
import { mcpValueSecret } from '../src/agent/mcp-connect.js';
import { testServices } from './helpers/services.js';

const model = { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' } as const;

it('copies servers with their own copy of each value, and leaves a sign-in to be made again', async () => {
  const services = await testServices();
  const source = await services.profiles.createProfile({
    name: 'Zero',
    instructions: 'Help.',
    model,
    mcpServers: [
      {
        name: 'linear',
        url: 'https://mcp.linear.example/mcp',
        auth: 'headers',
        headers: [{ name: 'Authorization', value: 'Bearer synthetic-linear-token' }],
      },
      { name: 'notion', url: 'https://mcp.notion.example/mcp', auth: 'oauth' },
      { name: 'docs', url: 'https://mcp.docs.example/mcp' },
    ],
  });
  const target = await services.profiles.createProfile({
    name: 'Miku',
    instructions: 'Help.',
    model,
    mcpServers: [{ name: 'docs', url: 'https://other-docs.example/mcp' }],
  });

  const result = await services.profiles.importMcpServers(target.id, {
    fromProfileId: source.id,
  });

  expect(result).toEqual({
    imported: ['linear', 'notion'],
    skipped: [{ name: 'docs', reason: 'This profile already has a server with this name' }],
    signIn: ['notion'],
  });

  const imported = await services.profiles.profile(target.id);

  expect(imported.mcpServers.map((server) => server.name)).toEqual(['docs', 'linear', 'notion']);
  // The value never enters the profile document; it is in this profile's vault.
  expect(JSON.stringify(imported)).not.toContain('synthetic-linear-token');

  const secret = mcpValueSecret('linear', 'header', 'Authorization');

  expect(await services.vault.read(target.id, secret)).toBe('Bearer synthetic-linear-token');

  // Two copies: a new key on the source leaves the imported one as it was.
  const current = await services.profiles.profile(source.id);

  await services.profiles.updateProfile(source.id, {
    expectedVersion: current.version,
    mcpServers: current.mcpServers.map((server) =>
      server.name === 'linear'
        ? { ...server, headers: [{ name: 'Authorization', value: 'Bearer rotated-token' }] }
        : server,
    ),
  });

  expect(await services.vault.read(target.id, secret)).toBe('Bearer synthetic-linear-token');

  await expect(
    services.profiles.importMcpServers(target.id, { fromProfileId: target.id }),
  ).rejects.toThrow('another profile');
});
