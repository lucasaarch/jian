import {
  type CapturedFrame,
  type DocumentSnapshot,
  type InspectionCapture,
  packInspection,
  type Resource,
  snapshotDocument,
} from '@jian/browser-core';
import type { PageInspectionInput } from '@jian/contracts';
import { nativeImage, type WebContents } from 'electron';

export const allowed = (url: string) => {
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
};

/**
 * Origin, path and query name a page. A fragment is client state inside it and a trailing slash is
 * spelling, so neither makes the owner's open page "another page".
 */
const pageKey = (url: string) => {
  const parsed = new URL(url);
  parsed.hash = '';
  parsed.pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  return parsed.href;
};

const NETWORK_BUFFERS = {
  maxTotalBufferSize: 50 * 1024 * 1024,
  maxResourceBufferSize: 5 * 1024 * 1024,
};
/** No request in flight for this long reads as loaded; the same rule as Playwright's networkidle. */
const QUIET_MS = 500;
/** A page that never goes quiet (long polling, analytics) is captured as it stands at this cap. */
const LOAD_SETTLE_MS = 10_000;
const ACTION_SETTLE_MS = 3_000;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
type CdpResponse = { url: string; mimeType: string; status: number };
type CdpEvent = {
  requestId?: string;
  request?: { url: string };
  response?: CdpResponse;
  blockedReason?: string;
  errorText?: string;
  sessionId?: string;
  targetInfo?: { type: string };
};

/** Reads the page in `contents` into an export, the page itself left as the owner has it. */
export async function inspectContents(
  contents: WebContents,
  input: PageInspectionInput,
  signal: AbortSignal,
  hooks: { inspecting: Set<number>; cancelled: () => void; finished: () => void },
): Promise<InspectionCapture> {
  hooks.inspecting.add(contents.id);
  const debugger_ = contents.debugger;
  let released = false;
  const release = () => {
    released = true;
    hooks.inspecting.delete(contents.id);
    debugger_.off('message', message);
  };
  const cancel = () => {
    release();
    // A reused page is the owner's: their state and login outlive the agent's inspection.
    if (input.reusePage && !contents.isDestroyed() && debugger_.isAttached()) debugger_.detach();
    hooks.cancelled();
  };
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) {
    cancel();
    throw new Error('The browser inspection was cancelled');
  }
  const resources: Resource[] = [];
  const blocked: Array<{ url: string; reason: string }> = [];
  const requested = new Map<string, string>();
  const responses = new Map<string, CdpResponse>();
  const inFlight = new Set<string>();
  const pending = new Set<Promise<void>>();
  // Cross-origin frames live in other renderers, which CDP exposes as child sessions. Artifact
  // viewers and embeds keep their content there, so the root session alone cannot see it.
  const sessions = new Set<string | undefined>([undefined]);
  let activity = Date.now();
  let bytes = 0;
  const message = (
    _event: Electron.Event,
    method: string,
    params: CdpEvent,
    sessionId?: string,
  ) => {
    if (method === 'Target.attachedToTarget' && params.sessionId) {
      if (params.targetInfo?.type !== 'iframe') return;
      sessions.add(params.sessionId);
      void debugger_
        .sendCommand('Network.enable', NETWORK_BUFFERS, params.sessionId)
        .catch(() => {});
      void debugger_
        .sendCommand(
          'Target.setAutoAttach',
          { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
          params.sessionId,
        )
        .catch(() => {});
      return;
    }
    if (method === 'Target.detachedFromTarget' && params.sessionId) {
      sessions.delete(params.sessionId);
      for (const key of inFlight) if (key.startsWith(`${params.sessionId}:`)) inFlight.delete(key);
      return;
    }
    if (!params.requestId) return;
    // Electron reports the root session as '', which CDP refuses when it is sent back.
    const session = sessionId || undefined;
    const key = `${session ?? ''}:${params.requestId}`;
    if (method === 'Network.requestWillBeSent' && params.request) {
      requested.set(key, params.request.url);
      inFlight.add(key);
      activity = Date.now();
    }
    if (method === 'Network.responseReceived' && params.response)
      responses.set(key, params.response);
    if (method === 'Network.loadingFailed') {
      inFlight.delete(key);
      activity = Date.now();
      // A request this browser refused is a hole in the export, and the export must say so.
      const url = requested.get(key);
      if (url && (params.blockedReason || params.errorText === 'net::ERR_BLOCKED_BY_CLIENT'))
        blocked.push({ url, reason: 'Network writes and sockets are blocked during inspection' });
    }
    if (method !== 'Network.loadingFinished') return;
    inFlight.delete(key);
    activity = Date.now();
    const response = responses.get(key);
    if (!response || !allowed(response.url)) return;
    if (resources.length >= 200 || bytes > 50 * 1024 * 1024) {
      blocked.push({ url: response.url, reason: 'Export resource limit reached' });
      return;
    }
    const task = debugger_
      .sendCommand('Network.getResponseBody', { requestId: params.requestId }, session)
      .then((body) => {
        const data = Buffer.from(body.body, body.base64Encoded ? 'base64' : 'utf8');
        if (data.length > 5 * 1024 * 1024 || bytes + data.length > 50 * 1024 * 1024) {
          blocked.push({ url: response.url, reason: 'Export resource size limit reached' });
          return;
        }
        bytes += data.length;
        resources.push({ url: response.url, mimeType: response.mimeType, data });
      })
      .catch(() => {
        blocked.push({ url: response.url, reason: 'Resource body could not be exported' });
      })
      .finally(() => pending.delete(task));
    pending.add(task);
  };
  const settled = async (cap: number) => {
    activity = Date.now();
    const limit = activity + cap;
    while (!signal.aborted && Date.now() < limit) {
      if (inFlight.size === 0 && Date.now() - activity >= QUIET_MS) break;
      await delay(100);
    }
    signal.throwIfAborted();
  };
  try {
    // Name what is open: a viewer may have redirected, and the agent can retry with that address.
    if (
      input.reusePage &&
      (!contents.getURL() || pageKey(contents.getURL()) !== pageKey(input.url))
    )
      throw new Error(
        `The requested page is not open in this profile browser (it shows ${contents.getURL() || 'nothing'}). Open it first, or use reusePage false`,
      );
    // A newly created WebContentsView has no renderer until its first navigation. CDP
    // commands sent before that would wait for a renderer we had not yet started.
    if (!contents.getURL()) await contents.loadURL('about:blank');
    debugger_.attach('1.3');
    debugger_.on('message', message);
    await debugger_.sendCommand('Network.enable', NETWORK_BUFFERS);
    await debugger_.sendCommand('Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
    await debugger_.sendCommand('Emulation.setDeviceMetricsOverride', {
      width: input.width,
      height: input.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    if (!input.reusePage) await contents.loadURL(input.url);
    await settled(LOAD_SETTLE_MS);
    for (const action of input.actions) {
      const frame = contents.mainFrame.framesInSubtree[action.frame];
      if (!frame) throw new Error(`Frame ${action.frame} is no longer available`);
      const argument = JSON.stringify(action);
      await frame.executeJavaScript(`((a) => {
          if (a.type === 'scroll') { window.scrollTo(a.x, a.y); return; }
          const nodes = document.querySelectorAll(a.selector);
          if (nodes.length !== 1) throw new Error('The selector must match exactly one element');
          const node = nodes[0];
          if (a.type === 'click') node.click();
          else { const prototype = node.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; const setter = Object.getOwnPropertyDescriptor(prototype, 'value').set; setter.call(node, a.text); node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true })); }
        })(${argument})`);
      await settled(ACTION_SETTLE_MS);
    }
    const frames: CapturedFrame[] = [];
    for (const [index, frame] of contents.mainFrame.framesInSubtree.entries()) {
      if (index >= 30) break;
      const snapshot = await frame
        .executeJavaScript(`(${snapshotDocument.toString()})()`)
        .then((value) => value as DocumentSnapshot)
        .catch(() => null);
      if (snapshot) frames.push({ index, url: frame.url, ...snapshot });
    }
    // CDP's resource tree includes responses loaded before inspection (for example after
    // the owner completed a login or challenge). The page keeps its state and its document is
    // not requested again, but Chromium repeats a subresource's GET, with the profile's cookies,
    // when its bytes are no longer cached. Non-GET requests stay refused during all of this.
    const collect = async (
      tree: {
        frame: { id: string; url: string; mimeType: string };
        resources?: Array<{ url: string; mimeType: string }>;
        childFrames?: unknown[];
      },
      session: string | undefined,
    ): Promise<void> => {
      // The tree lists a frame's own document apart from its subresources.
      for (const resource of [tree.frame, ...(tree.resources ?? [])]) {
        if (!allowed(resource.url) || resources.some((entry) => entry.url === resource.url))
          continue;
        if (resources.length >= 200 || bytes >= 50 * 1024 * 1024) {
          blocked.push({ url: resource.url, reason: 'Export resource limit reached' });
          break;
        }
        try {
          const body = await debugger_.sendCommand(
            'Page.getResourceContent',
            { frameId: tree.frame.id, url: resource.url },
            session,
          );
          const data = Buffer.from(body.content, body.base64Encoded ? 'base64' : 'utf8');
          if (data.length > 5 * 1024 * 1024 || bytes + data.length > 50 * 1024 * 1024) {
            blocked.push({ url: resource.url, reason: 'Export resource size limit reached' });
            continue;
          }
          bytes += data.length;
          resources.push({ url: resource.url, mimeType: resource.mimeType, data });
        } catch {
          blocked.push({
            url: resource.url,
            reason: 'Cached resource body could not be exported',
          });
        }
      }
      for (const child of tree.childFrames ?? [])
        await collect(child as Parameters<typeof collect>[0], session);
    };
    for (const session of sessions) {
      // Page.getResourceContent refuses with "Agent is not enabled" until this has run.
      await debugger_
        .sendCommand('Page.enable', {}, session)
        .then(() => debugger_.sendCommand('Page.getResourceTree', {}, session))
        .then((result) => collect(result.frameTree, session))
        .catch(() => {});
    }
    const shot = await debugger_.sendCommand('Page.captureScreenshot', {
      format: 'jpeg',
      quality: 85,
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: input.width, height: input.height, scale: 1 },
    });
    const screenshot = nativeImage.createFromBuffer(Buffer.from(shot.data, 'base64')).toJPEG(85);
    await Promise.allSettled([...pending]);
    // Two passes can reach one URL: keep one copy, and do not report as missing what the other
    // pass exported.
    const exported = [...new Map(resources.map((item) => [item.url, item])).values()];
    const urls = new Set(exported.map((item) => item.url));
    const { archive, snapshot } = packInspection({
      url: contents.getURL(),
      title: contents.getTitle(),
      viewport: { width: input.width, height: input.height },
      actions: input.actions,
      frames,
      resources: exported,
      blocked: blocked.filter((item) => !urls.has(item.url)),
      framesTruncated: contents.mainFrame.framesInSubtree.length > 30,
    });
    return { screenshot, archive, snapshot };
  } finally {
    signal.removeEventListener('abort', cancel);
    // Cancelling released this already; a later inspection may own the debugger by now.
    if (!released) {
      release();
      if (!contents.isDestroyed() && debugger_.isAttached()) {
        await debugger_.sendCommand('Emulation.clearDeviceMetricsOverride').catch(() => {});
        debugger_.detach();
      }
      hooks.finished();
    }
  }
}
