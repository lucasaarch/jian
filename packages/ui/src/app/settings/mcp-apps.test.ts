import { mcpSchema } from '@jian/contracts';
import { describe, expect, it } from 'vitest';
import { freeName, MCP_APPS } from './mcp-apps';

// Connect saves the app under this name, and the gateway refuses the whole list when one name
// breaks its rule: Reactive Resume's id has a hyphen, and connecting it failed with a 400.
describe('the name an app is saved under', () => {
  const nameRule = mcpSchema.shape.name;

  it.each(MCP_APPS.map((app) => [app.id, app] as const))('fits the rule for %s', (_, app) => {
    expect(nameRule.safeParse(freeName(app, [])).success).toBe(true);
    const first = freeName(app, []);
    expect(nameRule.safeParse(freeName(app, [first])).success).toBe(true);
  });

  it('is Reactive Resume with an underscore, then the next free one', () => {
    const app = MCP_APPS.find((item) => item.id === 'reactive-resume');
    expect(app && freeName(app, [])).toBe('reactive_resume');
    expect(app && freeName(app, ['reactive_resume'])).toBe('reactive_resume_2');
  });
});
