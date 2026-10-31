import type { RemoteBrowserParams } from '@jian/contracts';
import type { Remote } from '../remote/service.js';
import { decodeActed, decodeCapture, type NativeBrowser } from './native.js';

/** The owner is not looking at this conversation in any app: nothing was done. */
export class BrowserNotShowing extends Error {
  constructor() {
    super(
      "The owner's Jian desktop app is not showing this conversation, so the browser beside it cannot be used now. Nothing was done. Ask them to open this conversation in the app, then try again.",
    );
  }
}

/**
 * The browser beside the conversation on a server gateway, reached through the desktop app that
 * is one of its machines. It only ever acts where the owner is watching: an app showing another
 * conversation refuses before doing anything, so with several computers the one looking at this
 * conversation is the one that answers.
 */
export function machineBrowser(
  remote: Pick<Remote, 'browserMachines' | 'executeBrowser'>,
  target?: string,
): NativeBrowser {
  const ask = async (
    operation: RemoteBrowserParams['operation'],
    input: unknown,
    scope: { profileId: string; sessionId: string },
    signal: AbortSignal,
  ) => {
    for (const machine of await remote.browserMachines(target)) {
      const { browser, stderr } = await remote.executeBrowser(
        scope.profileId,
        machine.id,
        { operation, profileId: scope.profileId, sessionId: scope.sessionId, input },
        signal,
      );
      if (!browser) throw new Error(stderr || `${machine.name} did not answer`);
      if (browser.notShowing) continue;
      if (browser.error) throw new Error(browser.error);
      return browser;
    }
    throw new BrowserNotShowing();
  };

  return {
    watching: async (scope, signal) => {
      for (const machine of await remote.browserMachines(target)) {
        const { browser } = await remote.executeBrowser(
          scope.profileId,
          machine.id,
          {
            operation: 'check',
            profileId: scope.profileId,
            sessionId: scope.sessionId,
            input: null,
          },
          signal,
        );
        if (browser && !browser.notShowing) return true;
      }
      return false;
    },
    reaches: async () => (await remote.browserMachines(target)).length > 0,
    aimedAt: (machineId) => machineBrowser(remote, machineId),
    inspect: async (input, scope, signal) => {
      const { capture } = await ask('inspect', input, scope, signal);
      if (!capture) throw new Error('The desktop app returned no inspection');
      return decodeCapture(capture as Parameters<typeof decodeCapture>[0]);
    },
    act: async (input, scope, signal) => {
      const { acted } = await ask('act', input, scope, signal);
      if (!acted) throw new Error('The desktop app returned no result');
      return decodeActed(acted as Parameters<typeof decodeActed>[0]);
    },
  };
}
