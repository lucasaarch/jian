import { type DocumentSnapshot, snapshotDocument } from '@jian/browser-core';
import type { BrowserActionFrame, BrowserActionInput, BrowserActionResult } from '@jian/contracts';
import { nativeImage, type WebContents, type WebFrameMain } from 'electron';
import type { BrowserPointer } from './browser-pointer';

const LOAD_LIMIT_MS = 8000;
const AFTER_INPUT_MS = 350;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Point = { x: number; y: number };

/** Where an element's centre is on screen, scrolled into view first. */
async function locate(contents: WebContents, frameIndex: number, selector: string): Promise<Point> {
  const frame: WebFrameMain | undefined = contents.mainFrame.framesInSubtree[frameIndex];
  if (!frame) throw new Error(`Frame ${frameIndex} is no longer available`);
  const found = (await frame.executeJavaScript(`((selector) => {
    const nodes = document.querySelectorAll(selector);
    if (nodes.length !== 1) return { error: 'The selector must match exactly one element; it matched ' + nodes.length };
    nodes[0].scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const box = nodes[0].getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2, inner: innerWidth };
  })(${JSON.stringify(selector)})`)) as
    | (Point & { inner: number; error?: undefined })
    | { error: string };
  if (found.error !== undefined) throw new Error(found.error);
  let { x, y, inner } = found;
  // A frame reports its own coordinates. Each element holding it maps them out, its zoom included:
  // an artifact viewer shows its design scaled down.
  for (let child = frame; child.parent; child = child.parent) {
    const parent: WebFrameMain = child.parent;
    const owner = (await parent.executeJavaScript(`((index) => {
      const element = document.querySelectorAll('iframe, frame')[index];
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return { x: box.x + element.clientLeft, y: box.y + element.clientTop, width: box.width, inner: innerWidth };
    })(${parent.frames.indexOf(child)})`)) as (Point & { width: number; inner: number }) | null;
    if (!owner) throw new Error(`Frame ${frameIndex} is no longer on the page`);
    const scale = inner ? owner.width / inner : 1;
    x = owner.x + x * scale;
    y = owner.y + y * scale;
    inner = owner.inner;
  }
  return { x, y };
}

async function settled(contents: WebContents, signal: AbortSignal) {
  await delay(AFTER_INPUT_MS);
  const limit = Date.now() + LOAD_LIMIT_MS;
  while (contents.isLoading() && Date.now() < limit && !signal.aborted) await delay(100);
  signal.throwIfAborted();
}

/** Real input events, as the owner's own hand: a page reacts to them as it would to a person. */
function click(contents: WebContents, { x, y }: Point) {
  contents.sendInputEvent({ type: 'mouseMove', x, y });
  contents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  contents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
}

function press(contents: WebContents, key: string) {
  contents.sendInputEvent({ type: 'keyDown', keyCode: key });
  if (key === 'Enter') contents.sendInputEvent({ type: 'char', keyCode: '\r' });
  if (key === 'Tab') contents.sendInputEvent({ type: 'char', keyCode: '\t' });
  contents.sendInputEvent({ type: 'keyUp', keyCode: key });
}

async function report(
  contents: WebContents,
  viewport: { width: number; height: number },
  visible: boolean,
  screenshot: Buffer | null,
): Promise<BrowserActionResult<Buffer>> {
  const frames: BrowserActionFrame[] = [];
  for (const [index, frame] of contents.mainFrame.framesInSubtree.entries()) {
    if (index >= 30) break;
    const snapshot = await frame
      .executeJavaScript(`(${snapshotDocument.toString()})()`)
      .then((value) => value as DocumentSnapshot)
      .catch(() => null);
    if (snapshot)
      frames.push({
        index,
        url: frame.url,
        title: snapshot.title,
        text: snapshot.text.slice(0, 1500),
        controls: snapshot.controls.slice(0, 40),
      });
  }
  return {
    url: contents.getURL(),
    title: contents.getTitle(),
    viewport,
    visible,
    screenshot,
    frames,
  };
}

const SHOT_LIMIT_MS = 4000;

/**
 * The page at the size the owner sees it, so its pixels are the coordinates a click takes. A shot
 * waits for the next frame, and a page off screen with nothing changing never draws one: a metrics
 * override makes it draw. An action never waits on its picture past the limit.
 */
async function shoot(
  contents: WebContents,
  size: { width: number; height: number },
  offScreen: boolean,
): Promise<Buffer | null> {
  const debug = contents.debugger;
  let timer: NodeJS.Timeout | undefined;
  try {
    debug.attach('1.3');
    if (offScreen)
      await debug.sendCommand('Emulation.setDeviceMetricsOverride', {
        width: Math.round(size.width),
        height: Math.round(size.height),
        deviceScaleFactor: 1,
        mobile: false,
      });
    const limit = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), SHOT_LIMIT_MS);
    });
    const shot = await Promise.race([
      debug.sendCommand('Page.captureScreenshot', { format: 'jpeg', quality: 80 }),
      limit,
    ]);
    if (!shot) return null;
    return nativeImage
      .createFromBuffer(Buffer.from(shot.data, 'base64'))
      .resize({ width: Math.round(size.width) })
      .toJPEG(80);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    if (!contents.isDestroyed() && debug.isAttached()) debug.detach();
  }
}

/**
 * One action in the page the owner sees. A click or a key needs the page on screen: something
 * covering it means the owner is busy elsewhere in the app, and the agent is told, not ignored.
 */
export async function runBrowserAction(
  contents: WebContents,
  input: BrowserActionInput,
  context: {
    /** Absent off screen: the owner is elsewhere, and nothing there is theirs to watch. */
    pointer?: BrowserPointer;
    signal: AbortSignal;
    bounds: () => { width: number; height: number };
    visible: () => boolean;
    open: (url: string) => Promise<void>;
    offScreen: () => boolean;
    focus: () => void;
    /** Puts keyboard focus back where the owner had it, once the action has typed. */
    keepFocus: () => () => void;
  },
): Promise<BrowserActionResult<Buffer>> {
  const { pointer, signal, bounds, visible } = context;
  const needsInput = ['click', 'type', 'key', 'scroll'].includes(input.action);
  if (needsInput && !visible())
    throw new Error(
      'Jian Browser is not on screen: the window is hidden or a dialog covers it. Try again when the owner is back, or tell them.',
    );
  if (input.action !== 'open' && !contents.getURL())
    throw new Error('No page is open yet; open one first');

  const pointAt = async () => {
    const point = input.selector
      ? await locate(contents, input.frame, input.selector)
      : { x: input.x ?? 0, y: input.y ?? 0 };
    await pointer?.moveTo(point, signal);
    signal.throwIfAborted();
    return point;
  };
  const history = contents.navigationHistory;

  switch (input.action) {
    case 'open':
      await context.open(input.url ?? '');
      break;
    case 'back':
      if (history.canGoBack()) history.goBack();
      break;
    case 'forward':
      if (history.canGoForward()) history.goForward();
      break;
    case 'reload':
      contents.reload();
      break;
    case 'click': {
      const point = await pointAt();
      pointer?.press();
      click(contents, point);
      break;
    }
    case 'type': {
      const restore = context.keepFocus();
      try {
        context.focus();
        if (input.selector) {
          const point = await pointAt();
          pointer?.press();
          click(contents, point);
          await delay(80);
        }
        await contents.insertText(input.text ?? '');
        if (input.submit) press(contents, 'Enter');
      } finally {
        restore();
      }
      break;
    }
    case 'key': {
      const restore = context.keepFocus();
      try {
        context.focus();
        press(contents, input.key ?? 'Enter');
      } finally {
        restore();
      }
      break;
    }
    case 'scroll': {
      const { width, height } = bounds();
      const point = { x: width / 2, y: height / 2 };
      await pointer?.moveTo(point, signal);
      // A wheel scrolls down with a negative delta; this tool's positive means down, as a page's.
      contents.sendInputEvent({
        type: 'mouseWheel',
        ...point,
        deltaX: -input.deltaX,
        deltaY: -input.deltaY,
      });
      break;
    }
    case 'read':
      break;
  }

  await settled(contents, signal);
  pointer?.rest();
  const size = bounds();
  const onScreen = visible();
  return report(
    contents,
    size,
    onScreen,
    onScreen ? await shoot(contents, size, context.offScreen()) : null,
  );
}
