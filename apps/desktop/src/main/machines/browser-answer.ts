import type { RemoteBrowserParams, RemoteBrowserResult } from '@jian/contracts';
import type { JianBrowser } from '../browser';

/** How long an action may take here; the browser gives up first, at 45 seconds. */
const TIMEOUT_MS = 55_000;
/**
 * How long, in milliseconds, it waits for the window to reach the conversation before refusing:
 * a new chat's first message starts its run a moment before the window opens that chat.
 */
const ARRIVING_MS = 3_000;
const LOOK_EVERY_MS = 100;

type Showing = { gatewayId: string; sessionId?: string | undefined } | null;

async function arrives(look: () => Showing, gatewayId: string, sessionId: string, wait: number) {
  const here = () => {
    const showing = look();
    return showing?.gatewayId === gatewayId && showing.sessionId === sessionId;
  };
  for (let waited = 0; !here(); waited += LOOK_EVERY_MS) {
    if (waited >= wait) return false;
    await new Promise((resolve) => setTimeout(resolve, LOOK_EVERY_MS));
  }
  return true;
}

/**
 * Answers a server gateway that wants the browser beside a conversation. It has no port of its
 * own to this app as a local gateway has, and acts in a browser with the owner's logins: it does
 * nothing unless the owner has that very conversation on screen, where they can watch it and step
 * in. Asked to look elsewhere it refuses before anything has happened.
 */
export async function browserAnswer(
  browser: Pick<JianBrowser, 'act' | 'inspect'>,
  gatewayId: string,
  params: RemoteBrowserParams,
  showing: () => Showing,
  wait = ARRIVING_MS,
): Promise<RemoteBrowserResult> {
  if (!(await arrives(showing, gatewayId, params.sessionId, wait))) return { notShowing: true };
  if (params.operation === 'check') return {};
  const scope = { gatewayId, profileId: params.profileId, sessionId: params.sessionId };
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  try {
    if (params.operation === 'inspect') {
      const capture = await browser.inspect(
        scope,
        params.input as Parameters<JianBrowser['inspect']>[1],
        signal,
      );
      return {
        capture: {
          screenshot: Buffer.from(capture.screenshot).toString('base64'),
          archive: Buffer.from(capture.archive).toString('base64'),
          snapshot: capture.snapshot,
        },
      };
    }
    const acted = await browser.act(scope, params.input, signal);
    return {
      acted: {
        ...acted,
        screenshot: acted.screenshot ? acted.screenshot.toString('base64') : null,
      },
    };
  } catch (failure) {
    return {
      error: (failure instanceof Error ? failure.message : 'The browser action failed').slice(
        0,
        2000,
      ),
    };
  }
}
