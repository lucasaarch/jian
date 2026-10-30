import {
  type AppHost,
  forgetGatewayCache,
  type GatewaySettings,
  openUpdates,
  type UpdatesHost,
} from '@jian/ui';
import { type GatewaySummary, STATUS_SAID } from '../../shared/bridge';
import { desktop } from '../desktop';
import { forget } from '../gateways/navigation';

/** The app's own updates, done by the main process; the update sheet draws them. */
export const updatesHost: UpdatesHost = {
  state: () => desktop().updates.state(),
  check: () => desktop().updates.check(),
  install: () => desktop().updates.install(),
  onChanged: (listener) => desktop().updates.onChanged(listener),
};

/** The app's settings, done by the main process. */
export const appHost: AppHost = {
  version: desktop().version,
  openAtLogin: {
    read: () => desktop().openAtLogin(),
    write: (open) => void desktop().setOpenAtLogin(open),
  },
  notifications: {
    read: () => desktop().notifications(),
    write: (on) => void desktop().setNotifications(on),
  },
  checkForUpdates: () => openUpdates({ check: true }),
};

/**
 * The gateway in use, for the settings: how it stands as the window knows it, and what only the
 * main process may do with it, as it keeps its token.
 */
export function gatewaySettings(gateway: GatewaySummary): GatewaySettings {
  return {
    info: {
      id: gateway.id,
      name: gateway.name,
      local: gateway.local,
      url: gateway.url,
      ...(gateway.version ? { version: gateway.version } : {}),
      state: STATUS_SAID[gateway.status],
    },
    actions: {
      replaceToken: (id, token) => desktop().replaceToken(id, token),
      remove: async (id) => {
        // Its place in the panel and what was kept of it go with it: added again, it starts afresh.
        forget(id);
        await forgetGatewayCache(id);
        await desktop().removeGateway(id);
      },
    },
  };
}
