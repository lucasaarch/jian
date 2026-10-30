import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { RemoteComputerParams } from '@jian/contracts';
import { HelperChannel } from './helper-channel.ts';
import { type ActionOutcome, failed, messageOf, succeeded } from './outcome.ts';
import {
  type DisplayGeometry,
  type DisplayPoint,
  imagePixelToPoint,
  type ShotGeometry,
  scaleFromGeometry,
} from './shared.ts';

/** Without an action for this long, the helper is told to idle its overlay, in ms. */
const IDLE_MS = 30_000;

export type ComputerAction = RemoteComputerParams['action'];
type Coordinate = NonNullable<RemoteComputerParams['coordinate']>;

/** A JPEG of the primary display, sized for the worker channel. */
export type Screenshot = { base64: string; widthPx: number; heightPx: number };

/** A screenshot taken by the native helper, which captures in-process and fits it to the channel. */
export async function captureThroughHelper(channel: HelperChannel): Promise<Screenshot> {
  const reply = await channel.call({ cmd: 'screenshot' }, 'Screenshot failed.');
  const { base64, widthPx, heightPx } = reply;
  if (typeof base64 !== 'string' || typeof widthPx !== 'number' || typeof heightPx !== 'number') {
    throw new Error('Screenshot produced no image data.');
  }
  return { base64, widthPx, heightPx };
}

/** What a platform learns just before an action that changes how its outcome reads. */
export type Preparation = {
  /** Said beside a screenshot that worked. */
  note: string;
  explain(message: string, action: ComputerAction): string;
};

/** What differs per OS. Everything else about a session is the same on all three. */
export type ComputerPlatform = {
  /** Starts the native helper; the session speaks JSON lines to it on stdin and stdout. */
  launch(): Promise<ChildProcessWithoutNullStreams>;
  /** Usually `captureThroughHelper`; a platform could capture another way. */
  capture(channel: HelperChannel): Screenshot | Promise<Screenshot>;
  /** Runs before every action that touches the screen, and never prevents it. */
  prepare?(): Preparation;
  /** Called on every action while the helper runs, so it must be idempotent. */
  hold?(pid: number): void;
  release?(): void;
};

const plain: Preparation = { note: '', explain: (message) => message };

/**
 * One agent's use of this screen: the helper process, the display it reported, and the last
 * screenshot, whose pixels are the coordinates the agent clicks in.
 */
export class ComputerSession {
  private readonly platform: ComputerPlatform;
  private channel: HelperChannel | null = null;
  private display: DisplayGeometry | null = null;
  /** Survives a helper crash: the agent's coordinates still refer to the same screenshot. */
  private shot: ShotGeometry | null = null;
  private idleTimer: NodeJS.Timeout | null = null;

  constructor(platform: ComputerPlatform) {
    this.platform = platform;
  }

  /** Never rejects: every failure is an outcome the agent can read. */
  async runAction(computer: RemoteComputerParams): Promise<ActionOutcome> {
    if (computer.action === 'end_session') {
      await this.end();
      return succeeded();
    }
    if (computer.action === 'wait') {
      const ms = Math.round((computer.duration ?? 0.35) * 1000);
      await new Promise((resolve) => setTimeout(resolve, ms));
      if (this.channel) this.bumpIdle();
      return succeeded();
    }

    const preparation = this.platform.prepare?.() ?? plain;
    try {
      const channel = await this.ensure();
      if (computer.action === 'screenshot') return await this.screenshot(channel, preparation.note);
      await this.input(channel, computer);
      this.bumpIdle();
      return succeeded();
    } catch (error) {
      return failed(preparation.explain(messageOf(error), computer.action));
    }
  }

  async end(): Promise<void> {
    this.clearIdle();
    this.platform.release?.();
    const channel = this.channel;
    this.channel = null;
    if (channel) {
      await channel.request({ cmd: 'endSession' }).catch(() => {});
      channel.kill();
    }
    this.display = null;
    this.shot = null;
  }

  private async ensure(): Promise<HelperChannel> {
    const channel = this.channel?.alive ? this.channel : await this.open();
    this.platform.hold?.(channel.pid ?? process.pid);
    this.bumpIdle();
    return channel;
  }

  private async open(): Promise<HelperChannel> {
    const channel = new HelperChannel(await this.platform.launch(), () => {
      if (this.channel !== channel) return;
      this.channel = null;
      this.clearIdle();
      this.platform.release?.();
    });
    this.channel = channel;
    try {
      await channel.call({ cmd: 'ping' }, 'Computer-use helper did not respond.');
      const geometry = await channel.call({ cmd: 'geometry' }, 'Could not read display geometry.');
      this.display = {
        originX: Number(geometry.originX) || 0,
        originY: Number(geometry.originY) || 0,
        pointWidth: Number(geometry.pointWidth),
        pointHeight: Number(geometry.pointHeight),
      };
      await channel.request({ cmd: 'ensureSession' });
      return channel;
    } catch (error) {
      // A helper that answered wrong is not reused: the next action starts a fresh one.
      this.channel = null;
      channel.kill();
      throw error;
    }
  }

  private async screenshot(channel: HelperChannel, note: string): Promise<ActionOutcome> {
    if (!this.display) throw new Error('Display geometry unavailable.');
    const shot = await this.platform.capture(channel);
    this.shot = { ...this.display, widthPx: shot.widthPx, heightPx: shot.heightPx };
    this.bumpIdle();
    return succeeded(
      { widthPx: shot.widthPx, heightPx: shot.heightPx, scale: scaleFromGeometry(this.shot) },
      { stdout: shot.base64, stderr: note },
    );
  }

  private async input(channel: HelperChannel, computer: RemoteComputerParams): Promise<void> {
    const { action } = computer;
    switch (action) {
      case 'mouse_move': {
        const at = this.point(computer.coordinate, 'coordinate is required for this action.');
        await channel.call({ cmd: 'move', ...at }, 'Move failed.');
        return;
      }
      case 'left_click':
      case 'right_click':
      case 'double_click': {
        const at = this.point(computer.coordinate, 'coordinate is required for this action.');
        const button = action === 'right_click' ? 'right' : 'left';
        const count = action === 'double_click' ? 2 : 1;
        // One request: the helper moves its pointer there, clicks, and restores the user's cursor.
        await channel.call({ cmd: 'clickAt', ...at, button, count }, 'Click failed.');
        return;
      }
      case 'left_click_drag': {
        const missing = 'startCoordinate and coordinate are required for drag.';
        const from = this.point(computer.startCoordinate, missing);
        const to = this.point(computer.coordinate, missing);
        await channel.call(
          { cmd: 'drag', fromX: from.pointX, fromY: from.pointY, toX: to.pointX, toY: to.pointY },
          'Drag failed.',
        );
        return;
      }
      case 'type': {
        if (!computer.text) throw new Error('text is required for type.');
        await channel.call({ cmd: 'type', text: computer.text }, 'Type failed.');
        return;
      }
      case 'key': {
        if (!computer.key) throw new Error('key is required for key.');
        await channel.call({ cmd: 'key', key: computer.key }, 'Key failed.');
        return;
      }
      case 'scroll': {
        const at = this.point(computer.coordinate, 'coordinate is required for scroll.');
        if (!computer.scrollDirection) throw new Error('scrollDirection is required for scroll.');
        await channel.call(
          {
            cmd: 'scroll',
            ...at,
            direction: computer.scrollDirection,
            amount: computer.scrollAmount ?? 3,
          },
          'Scroll failed.',
        );
        return;
      }
      default:
        throw new Error(`Unsupported computer action: ${action}`);
    }
  }

  /** A pixel of the last screenshot as a display point; there must be one, and it must hold it. */
  private point(coordinate: Coordinate | undefined, missing: string): DisplayPoint {
    if (!coordinate) throw new Error(missing);
    const shot = this.shot;
    if (!shot) throw new Error('Take a screenshot before using screen coordinates.');
    const [x, y] = coordinate;
    if (x < 0 || y < 0 || x >= shot.widthPx || y >= shot.heightPx) {
      throw new Error(
        `Coordinate (${x}, ${y}) is outside the last screenshot (${shot.widthPx}×${shot.heightPx}).`,
      );
    }
    return imagePixelToPoint(x, y, shot);
  }

  private bumpIdle(): void {
    this.clearIdle();
    this.idleTimer = setTimeout(() => {
      void this.channel?.request({ cmd: 'setIdle' }).catch(() => {});
    }, IDLE_MS);
    this.idleTimer.unref();
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}
