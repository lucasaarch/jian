import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mcpValueSecret } from '../src/agent/mcp-connect.js';
import { probeMcpServer } from '../src/agent/mcp-probe.js';
import { testServices } from './helpers/services.js';

const model = { provider: 'openai' as const, modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' };

/** A server that answers the handshake over stdin and stdout, as a real one does. */
function commandServer() {
  const directory = mkdtempSync(join(tmpdir(), 'jian-mcp-'));
  const script = join(directory, 'server.mjs');

  writeFileSync(
    script,
    `let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (;;) {
    const end = buffer.indexOf('\\n');
    if (end < 0) return;
    const line = buffer.slice(0, end).trim();
    buffer = buffer.slice(end + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.id === undefined) continue;
    const result =
      message.method === 'initialize'
        ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: process.env.SERVER_NAME ?? 'x', version: '1' } }
        : { tools: [{ name: 'echo', description: 'Says it back', inputSchema: { type: 'object' } }] };
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\\n');
  }
});
`,
  );

  return script;
}

describe('the ways an MCP server can be reached', () => {
  it('runs a command server and reads what it offers', async () => {
    const services = await testServices();
    const profile = await services.profiles.createProfile({
      name: 'Atlas',
      instructions: 'Help.',
      model,
      mcpServers: [
        {
          name: 'local',
          transport: 'stdio',
          command: process.execPath,
          args: [commandServer()],
          env: [{ name: 'SERVER_NAME', value: 'synthetic-secret' }],
        },
      ],
    });

    // The value the owner typed never stays on the profile.
    expect(JSON.stringify(profile)).not.toContain('synthetic-secret');
    expect(
      await services.vault.read(profile.id, mcpValueSecret('local', 'env', 'SERVER_NAME')),
    ).toBe('synthetic-secret');

    const status = await probeMcpServer(profile, 'local', services.vault);

    expect(status.reachable).toBe(true);
    expect(status.tools.map((tool) => tool.name)).toEqual(['echo']);
  });

  it('sends the header the owner wrote, whatever scheme it carries', async () => {
    const seen: string[] = [];
    const services = await testServices();

    const profile = await services.profiles.createProfile({
      name: 'Atlas',
      instructions: 'Help.',
      model,
      mcpServers: [
        {
          name: 'docs',
          url: 'https://mcp.example.com/mcp',
          auth: 'headers',
          headers: [
            { name: 'Authorization', value: 'Basic dXNlcjpwYXNz' },
            { name: 'X-Tenant', value: 'acme' },
          ],
        },
      ],
    });

    await probeMcpServer(profile, 'docs', services.vault, (async (_url, init) => {
      seen.push(String(new Headers(init?.headers).get('authorization')));
      seen.push(String(new Headers(init?.headers).get('x-tenant')));

      return Response.json({}, { status: 401 });
    }) as typeof globalThis.fetch);

    expect(seen).toContain('Basic dXNlcjpwYXNz');
    expect(seen).toContain('acme');
  });

  it('says which value is missing rather than failing on the network', async () => {
    const services = await testServices();
    const profile = await services.profiles.createProfile({
      name: 'Atlas',
      instructions: 'Help.',
      model,
      mcpServers: [
        {
          name: 'docs',
          url: 'https://mcp.example.com/mcp',
          auth: 'headers',
          headers: [{ name: 'Authorization', fromEnv: 'JIAN_MCP_ABSENT' }],
        },
      ],
    });

    const status = await probeMcpServer(profile, 'docs', services.vault, (async () => {
      throw new Error('the network must not be reached');
    }) as typeof globalThis.fetch);

    expect(status.reachable).toBe(false);
    expect(status.error).toContain('JIAN_MCP_ABSENT');
  });

  it('refuses OAuth on a command server, which has no browser to send anyone to', async () => {
    const services = await testServices();

    await expect(
      services.profiles.createProfile({
        name: 'Atlas',
        instructions: 'Help.',
        model,
        mcpServers: [{ name: 'local', transport: 'stdio', command: 'x', auth: 'oauth' }],
      }),
    ).rejects.toThrow();
  });
});
