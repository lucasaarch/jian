import { randomUUID } from 'node:crypto';
import type { InspectionCapture } from '@jian/browser-core';
import type {
  BrowserActionInput,
  BrowserActionResult,
  NativeBrowserReply,
  PageInspectionInput,
} from '@jian/contracts';

type Port = {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (message: { data: unknown }) => void): void;
};
type Scope = { profileId: string; sessionId: string };

/** The browser beside the owner's conversation; only a desktop app's own gateway has one. */
export type NativeBrowser = {
  inspect(
    input: PageInspectionInput,
    scope: Scope,
    signal: AbortSignal,
  ): Promise<InspectionCapture>;
  act(
    input: BrowserActionInput,
    scope: Scope,
    signal: AbortSignal,
  ): Promise<BrowserActionResult<Buffer>>;
};

type Reply = NativeBrowserReply<InspectionCapture['snapshot']>;

/** A local gateway asks its own Electron parent, never a caller-supplied browser endpoint. */
export function nativeBrowser(port: Port): NativeBrowser {
  const pending = new Map<
    string,
    { resolve: (reply: Reply) => void; reject: (error: Error) => void }
  >();
  port.on('message', ({ data }) => {
    if (!data || typeof data !== 'object') return;
    const reply = data as Reply;
    if (reply.type !== 'browser:result' || !reply.id) return;
    const task = pending.get(reply.id);
    if (!task) return;
    pending.delete(reply.id);
    if (reply.error) task.reject(new Error(reply.error));
    else task.resolve(reply);
  });
  const ask = (type: string, input: unknown, scope: Scope, signal: AbortSignal) => {
    const id = randomUUID();
    return new Promise<Reply>((resolve, reject) => {
      const abort = () => {
        pending.delete(id);
        port.postMessage({ type: 'browser:cancel', id });
        reject(new Error('The browser action was cancelled or timed out'));
      };
      if (signal.aborted) return abort();
      signal.addEventListener('abort', abort, { once: true });
      const finish = () => signal.removeEventListener('abort', abort);
      pending.set(id, {
        resolve: (reply) => {
          finish();
          resolve(reply);
        },
        reject: (error) => {
          finish();
          reject(error);
        },
      });
      port.postMessage({
        type,
        id,
        profileId: scope.profileId,
        sessionId: scope.sessionId,
        input,
      });
    });
  };
  return {
    inspect: async (input, scope, signal) => {
      const { capture } = await ask('browser:inspect', input, scope, signal);
      if (!capture) throw new Error('The native browser returned no inspection');
      return {
        screenshot: Buffer.from(capture.screenshot, 'base64'),
        archive: Buffer.from(capture.archive, 'base64'),
        snapshot: capture.snapshot,
      };
    },
    act: async (input, scope, signal) => {
      const { acted } = await ask('browser:act', input, scope, signal);
      if (!acted) throw new Error('The native browser returned no result');
      return {
        ...acted,
        screenshot: acted.screenshot ? Buffer.from(acted.screenshot, 'base64') : null,
      };
    },
  };
}
