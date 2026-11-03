import { expect, it } from 'vitest';
import { settingsOf } from './web-addresses';

it('opens the page an address names, and Settings alone on its first page', () => {
  expect(settingsOf('/settings')).toBe('');
  expect(settingsOf('/settings/apps')).toBe('apps');
  expect(settingsOf('/settings/mcp-servers/')).toBe('mcp-servers');
});

it('opens Apps from the Integrations addresses every gateway still sends the owner back to', () => {
  expect(settingsOf('/settings/integrations')).toBe('apps');
  expect(settingsOf('/settings/integrations/')).toBe('apps');
  expect(settingsOf('/settings/integrations/github')).toBe('apps');
});

it('opens nothing for an address that is not a settings page', () => {
  expect(settingsOf('/settings/apps/github')).toBeUndefined();
  expect(settingsOf('/settings/integrations/github/more')).toBeUndefined();
  expect(settingsOf('/agents/a1/sessions')).toBeUndefined();
  expect(settingsOf('/settingsx')).toBeUndefined();
});
