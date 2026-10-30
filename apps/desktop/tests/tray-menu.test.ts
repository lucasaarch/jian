import { describe, expect, it } from 'vitest';
import { type TrayState, trayMenu } from '../src/main/tray-menu';
import type { GatewaySummary, OpenTarget } from '../src/shared/bridge';

const local: GatewaySummary = {
  id: 'local',
  name: 'This computer',
  local: true,
  url: 'http://127.0.0.1:60378',
  status: 'online',
  unread: 0,
};
const server: GatewaySummary = {
  id: 'gw-1',
  name: 'jian.example.com',
  local: false,
  url: 'https://jian.example.com',
  status: 'offline',
  unread: 2,
};

/** The menu for a state, and what clicking its items asked of the app. */
function menu(state: Partial<TrayState>) {
  const opened: (OpenTarget | undefined)[] = [];
  const shared: boolean[] = [];
  const items = trayMenu(
    { gateways: [local, server], showing: null, sharing: undefined, ...state },
    { open: (target) => opened.push(target), setSharing: (on) => shared.push(on), quit: () => {} },
  );
  const item = (label: string) => {
    const found = items.find((entry) => entry.label?.startsWith(label));
    if (!found) throw new Error(`No item "${label}" in the menu.`);
    return found;
  };
  const click = (label: string) => (item(label).click as () => void)();
  return { item, click, opened, shared, labels: items.map((entry) => entry.label) };
}

describe('the tray menu', () => {
  it('switches the window to the gateway chosen, and checks the one it shows', () => {
    const tray = menu({ showing: 'gw-1' });
    expect(tray.item('jian.example.com').checked).toBe(true);
    expect(tray.item('This computer').checked).toBe(false);
    tray.click('This computer');
    expect(tray.opened).toEqual([{ gatewayId: 'local' }]);
  });

  it('starts a chat or searches on the gateway shown, the first before the window says', () => {
    const shown = menu({ showing: 'gw-1' });
    shown.click('New Chat');
    shown.click('Search Chats');
    expect(shown.opened).toEqual([
      { gatewayId: 'gw-1', panel: 'new-chat' },
      { gatewayId: 'gw-1', panel: 'search-chats' },
    ]);
    const first = menu({});
    first.click('New Chat');
    expect(first.opened).toEqual([{ gatewayId: 'local', panel: 'new-chat' }]);
  });

  it('offers no chat on a gateway that refused the token or runs another release', () => {
    for (const status of ['unauthorized', 'incompatible'] as const) {
      const tray = menu({ gateways: [{ ...local, status }], showing: 'local' });
      expect(tray.item('New Chat').enabled).toBe(false);
      expect(tray.item('Search Chats').enabled).toBe(false);
    }
  });

  it('turns sharing off from on, and is left out while it would change nothing', () => {
    expect(menu({ sharing: undefined }).labels).not.toContain('Let Agents Use This Computer');
    const on = menu({ sharing: true });
    expect(on.item('Let Agents Use This Computer').checked).toBe(true);
    on.click('Let Agents Use This Computer');
    expect(on.shared).toEqual([false]);
  });
});
