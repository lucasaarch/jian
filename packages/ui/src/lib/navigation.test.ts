import { expect, it } from 'vitest';
import { onPlugins, pluginsPath, skillAt, skillPath } from './navigation';

it('names a skill in the address of its page, and reads it back', () => {
  expect(skillPath('a1', 'trip-planning')).toBe('/agents/a1/plugins/skills/trip-planning');
  expect(skillAt('/agents/a1/plugins/skills/trip-planning')).toBe('trip-planning');
  expect(skillAt('/agents/a1/plugins/skills/trip-planning/')).toBe('trip-planning');
  // A name no skill can have still comes back as it was written.
  expect(skillAt(skillPath('a1', 'a b/c'))).toBe('a b/c');
  // Cut mid-escape, it names what the address says rather than failing the page.
  expect(skillAt('/agents/a1/plugins/skills/%E0%A4%A')).toBe('%E0%A4%A');
});

it('reads no skill from any other address', () => {
  expect(skillAt(pluginsPath('a1'))).toBeUndefined();
  expect(skillAt('/agents/a1/plugins/skills')).toBeUndefined();
  expect(skillAt('/agents/a1/plugins/skills/concise/more')).toBeUndefined();
  expect(skillAt('/agents/a1/skills/concise')).toBeUndefined();
});

it('counts a skill’s page as Plugins, so the sidebar keeps it marked', () => {
  expect(onPlugins('/agents/a1/plugins')).toBe(true);
  expect(onPlugins(skillPath('a1', 'concise'))).toBe(true);
  expect(onPlugins('/agents/a1/plugins/connectors/linear')).toBe(false);
  expect(onPlugins('/agents/a1/sessions')).toBe(false);
});
