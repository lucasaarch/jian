import { beforeEach, expect, it, vi } from 'vitest';

const { version } = vi.hoisted(() => ({ version: vi.fn() }));

vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util');
  return { execFile: Object.assign(() => {}, { [promisify.custom]: version }) };
});

beforeEach(() => {
  vi.resetModules();
  version.mockReset();
});

it.each([
  { cli: undefined, expected: '2.1.280' },
  { cli: '2.1.278 (Claude Code)', expected: '2.1.280' },
  { cli: '2.1.280 (Claude Code)', expected: '2.1.280' },
  { cli: '2.1.1000 (Claude Code)', expected: '2.1.1000' },
  { cli: '2.2.1 (Claude Code)', expected: '2.2.1' },
  { cli: '2026-invalid', expected: '2.1.280' },
])('sends a supported subscription version with CLI $cli', async ({ cli, expected }) => {
  if (cli === undefined) version.mockRejectedValue(new Error('ENOENT'));
  else version.mockResolvedValue({ stdout: cli });
  const { subscriptionFetch } = await import('../src/providers/claude-subscription.js');
  let agent: string | null = null;
  const fetcher = await subscriptionFetch(async (_input, init) => {
    agent = new Headers(init?.headers).get('user-agent');
    return Response.json({ ok: true });
  });
  await fetcher('https://api.anthropic.com/v1/messages', {
    headers: { 'user-agent': 'sdk-overwrites-the-configured-agent' },
  });
  expect(agent).toBe(`claude-code/${expected} (external, cli)`);
});
