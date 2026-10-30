import type { MenuItemConstructorOptions } from 'electron';
import { type GatewaySummary, type OpenTarget, STATUS_SAID } from '../shared/bridge';

/** What the tray's menu shows, read again each time it is rebuilt. */
export type TrayState = {
  gateways: readonly GatewaySummary[];
  /** The gateway the window shows; null until the window says, when it shows the first one. */
  showing: string | null;
  /**
   * Whether agents may use this computer; undefined while the app knows no server gateway, as
   * the app's own gateway never has a machine and the switch would change nothing.
   */
  sharing: boolean | undefined;
};

export type TrayActions = {
  /** Shows the window, taken where the target says when there is one. */
  open(target?: OpenTarget): void;
  setSharing(on: boolean): void;
  quit(): void;
};

/**
 * The tray's menu: what the window would do, reached without finding it first, and how every
 * gateway stands. New Chat and Search Chats act on the gateway the window shows; their shortcuts
 * are the window's own, so none is shown here, where they would not work.
 */
export function trayMenu(state: TrayState, actions: TrayActions): MenuItemConstructorOptions[] {
  const shown = state.gateways.find((gateway) => gateway.id === state.showing) ?? state.gateways[0];
  // Its panel shows no chats: the gateway runs another release or refused the token.
  const chats =
    shown !== undefined && shown.status !== 'incompatible' && shown.status !== 'unauthorized';
  const panel = (name: 'new-chat' | 'search-chats') => () => {
    if (shown) actions.open({ gatewayId: shown.id, panel: name });
  };

  return [
    { label: 'Open Jian', click: () => actions.open() },
    { label: 'New Chat', enabled: chats, click: panel('new-chat') },
    { label: 'Search Chats…', enabled: chats, click: panel('search-chats') },
    { type: 'separator' },
    // A greyed line titles the list on every system; a section header would need macOS 14.
    { label: 'Gateways', enabled: false },
    ...state.gateways.map(
      (gateway): MenuItemConstructorOptions => ({
        label: gatewayLabel(gateway),
        type: 'radio',
        checked: gateway.id === shown?.id,
        click: () => actions.open({ gatewayId: gateway.id }),
      }),
    ),
    ...(state.sharing === undefined
      ? []
      : [
          { type: 'separator' } as const,
          {
            label: 'Let Agents Use This Computer',
            type: 'checkbox' as const,
            checked: state.sharing,
            click: () => actions.setSharing(!state.sharing),
          },
        ]),
    { type: 'separator' },
    { label: 'Settings…', click: () => actions.open({ sheet: 'settings' }) },
    { label: 'Check for Updates…', click: () => actions.open({ sheet: 'updates' }) },
    { type: 'separator' },
    { label: 'Quit Jian', click: actions.quit },
  ];
}

/**
 * A gateway's name, its unread chats and, unless it is connected, how it stands: in the label
 * itself, as a sublabel shows only from macOS 14.4 and nowhere else.
 */
function gatewayLabel(gateway: GatewaySummary): string {
  const unread = gateway.unread > 0 ? ` · ${gateway.unread} unread` : '';
  const status = gateway.status === 'online' ? '' : ` — ${STATUS_SAID[gateway.status]}`;
  return `${gateway.name}${unread}${status}`;
}
