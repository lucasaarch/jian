import { expect, it } from 'vitest';
import { movedToPlugins, settingsOf } from './web-addresses';

it('opens the page an address names, and Settings alone on its first page', () => {
  expect(settingsOf('/settings')).toBe('');
  expect(settingsOf('/settings/models')).toBe('models');
  expect(settingsOf('/settings/machines/')).toBe('machines');
});

it('opens nothing for the pages that became Plugins, which are sent on there', () => {
  for (const address of [
    '/settings/apps',
    '/settings/mcp-servers/',
    // Where every gateway still sends the owner back to from GitHub and X.
    '/settings/integrations',
    '/settings/integrations/',
    '/settings/integrations/github',
  ]) {
    expect(settingsOf(address)).toBeUndefined();
    expect(movedToPlugins(address)).toBe(true);
  }
});

it('opens nothing for an address that is not a settings page', () => {
  expect(settingsOf('/settings/models/more')).toBeUndefined();
  expect(settingsOf('/agents/a1/sessions')).toBeUndefined();
  expect(settingsOf('/settingsx')).toBeUndefined();
});

it('leaves the other addresses where they are', () => {
  expect(movedToPlugins('/settings')).toBe(false);
  expect(movedToPlugins('/settings/models')).toBe(false);
  expect(movedToPlugins('/settings/appsx')).toBe(false);
  expect(movedToPlugins('/agents/a1/settings/apps')).toBe(false);
});
