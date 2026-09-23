import { expect, it } from 'vitest';
import { boundToolResult } from '../src/agent/results.js';
import { profileTools } from '../src/agent/tools.js';
import { tokenCounter } from '../src/context/budget.js';
import { Coordination } from '../src/coordination/service.js';
import { testServices } from './helpers/services.js';

async function fixture() {
  const services = await testServices();
  const profile = await services.profiles.createProfile({
    name: 'Reader',
    instructions: 'Help.',
    contextPolicy: { toolResultTokens: 2560 },
    model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
  });
  const session = await services.sessions.createSession(profile.id, { title: 'Results' });
  const run = await services.runs.submit(profile.id, session.id, {
    text: 'Read',
    requestKey: 'read',
  });
  return { services, profile, run };
}

it('keeps structured MCP data readable without encoding JSON inside JSON', async () => {
  const { run } = await fixture();
  const data = { items: [{ id: 'receipt-123', title: 'Entrega', state: 'OPEN' }] };
  const result = await boundToolResult(
    {
      content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
      isError: true,
    },
    'mcp__test_search',
    run,
    new Set(),
    {},
  );
  expect(result).toEqual({ data, isError: true });
});

it('reads full pages within the token limit without skipping Unicode or JSON escapes', async () => {
  const { services, run } = await fixture();
  const coordination = new Coordination(services);
  const original = { value: 'Entrega São Paulo "pronto"\n'.repeat(160) };
  const artifact = await coordination.storeArtifact(run, 'read', original);
  const read = profileTools(services, run).read_artifact?.execute as (
    input: unknown,
    options: unknown,
  ) => Promise<{ content: string; nextOffset: number | null }>;
  let offset: number | null = 0;
  let content = '';
  const count = tokenCounter(run.profile.model.provider, run.profile.model.modelId);
  let pages = 0;
  while (offset !== null) {
    const page = await read(
      { artifactId: artifact.artifactId, offset, limit: 4000 },
      { messages: [], toolCallId: 'read' },
    );
    expect(count(JSON.stringify(page))).toBeLessThanOrEqual(2560);
    if (pages === 0) expect(page.content.length).toBeGreaterThan(1200);
    content += page.content;
    offset = page.nextOffset;
    expect(++pages).toBeLessThan(10);
  }
  expect(JSON.parse(content)).toEqual(original);
});
