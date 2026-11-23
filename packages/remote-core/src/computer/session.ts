import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { RemoteComputerParams } from '@jian/contracts';
import { HelperChannel } from './helper-channel.ts';
import {
  type ActionOutcome,
  type Failure,
  failed,
  failureOf,
  messageOf,
  refused,
  succeeded,
} from './outcome.ts';
import {
  type DisplayGeometry,
  type DisplayPoint,
  imagePixelToPoint,
  type ShotGeometry,
  scaleFromGeometry,
} from './shared.ts';

/** Without an action for this long, the helper is told to idle a pointer, in ms. */
const IDLE_MS = 30_000;
/**
 * Without an action for this long a seat is over, in ms. Only the agent says `end_session`, and a
 * run that was cancelled or failed never does: its pointer, the helper and the assertion keeping
 * the display awake would stay until the worker restarts. Far longer than a model thinks.
 */
const SEAT_IDLE_MS = 30 * 60_000;
/** How long the helper gets to take an idle seat's pointer away before it is stopped, in ms. */
const LEAVE_WAIT_MS = 5_000;
/** How many expired seats are remembered, so each is told to look again when it comes back. */
const EXPIRED_KEPT = 256;

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
  explain(message: string, action: ComputerAction, failure: Failure): string;
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
 * One conversation's place at this screen: its pointer, and the last screenshot it took, whose
 * pixels are the coordinates its agent clicks in.
 */
type Seat = {
  /** Survives a helper crash: the agent's coordinates still refer to the same screenshot. */
  shot: ShotGeometry | null;
  /** The helper that draws this seat's pointer. A new helper has to be told of the seat again. */
  channel: HelperChannel | null;
  idleTimer: NodeJS.Timeout | null;
  /** Ends the seat. Outlives the helper: a seat left by a crash must not hold the next one. */
  expiry: NodeJS.Timeout | null;
  /**
   * The screen was acted on since this seat last looked at it: by another conversation, or by
   * an action of its own that was cut short. Its next screenshot clears it.
   */
  stale: boolean;
};

/** A gateway from before sessions sends none: everything it asks for shares this one seat. */
const SHARED_SEAT = '';

/**
 * What changes the screen under the other conversations. Moving a pointer only moves Jian's
 * own drawing of it, never the user's cursor.
 */
const ACTS: ReadonlySet<ComputerAction> = new Set([
  'left_click',
  'right_click',
  'double_click',
  'left_click_drag',
  'type',
  'key',
  'scroll',
]);

const SCREEN_CHANGED =
  'The screen may have changed since your last screenshot: another agent used this computer, or an action was cut short. Nothing was sent. Take a screenshot and look again before acting.';

/**
 * Computer Use on this machine: one helper process and one screen, shared by every conversation
 * that uses it. Actions run one at a time, in the order they arrive; each conversation has its
 * own seat, and is refused an action aimed at a screen another one has changed since.
 */
export class ComputerSession {
  private readonly platform: ComputerPlatform;
  private channel: HelperChannel | null = null;
  private readonly seats = new Map<string, Seat>();
  /** The action in hand and all before it: the next one starts when this settles. */
  private queue: Promise<unknown> = Promise.resolve();
  /** Actions asked for and not answered yet: while there is one, no seat is idle. */
  private acting = 0;
  private readonly expired = new Set<string>();
  private readonly seatIdleMs: number;

  constructor(platform: ComputerPlatform, { seatIdleMs = SEAT_IDLE_MS } = {}) {
    this.platform = platform;
    this.seatIdleMs = seatIdleMs;
  }

  /** Never rejects: every failure is an outcome the agent can read. */
  runAction(computer: RemoteComputerParams): Promise<ActionOutcome> {
    this.acting += 1;
    const outcome = this.queue
      .then(() => this.act(computer))
      .finally(() => {
        this.acting -= 1;
      });
    this.queue = outcome.catch(() => {});
    return outcome;
  }

  /**
   * Stops whatever is running, for an action that outlived its time limit: the helper is
   * killed, so a stuck one cannot go on to press something later. Every seat has to look at
   * the screen again, since nobody knows how far the action got.
   */
  abort(message: string): void {
    for (const seat of this.seats.values()) seat.stale = true;
    this.channel?.stop(message);
  }

  /** Ends every seat and the helper. */
  async end(): Promise<void> {
    for (const id of [...this.seats.keys()]) await this.leave(id);
    this.close();
  }

  private async act(computer: RemoteComputerParams): Promise<ActionOutcome> {
    const { action } = computer;
    const id = computer.session?.id ?? SHARED_SEAT;
    if (action === 'end_session') {
      this.expired.delete(id);
      await this.leave(id);
      return succeeded();
    }
    if (action === 'wait') {
      const ms = Math.round((computer.duration ?? 0.35) * 1000);
      await new Promise((resolve) => setTimeout(resolve, ms));
      const seat = this.seats.get(id);
      if (seat?.channel) this.bumpIdle(seat, id);
      if (seat) this.keep(seat, id);
      return succeeded();
    }

    const seat = this.seat(id);
    const preparation = this.platform.prepare?.() ?? plain;
    try {
      if (seat.stale && ACTS.has(action)) throw refused(SCREEN_CHANGED, 'screen_changed');
      const channel = await this.ensure(seat, id, computer.session);
      if (action === 'screenshot') return await this.screenshot(channel, seat, preparation.note);
      await this.input(channel, seat, id, computer);
      this.changed(seat, action);
      return succeeded();
    } catch (error) {
      const failure = failureOf(error);
      if (failure.delivery === 'uncertain') this.changed(seat, action);
      // Privacy permissions are read when a process starts: a helper that was refused would go
      // on being refused after the owner grants them.
      if (failure.code === 'perm_denied') this.close();
      return failed(preparation.explain(messageOf(error), action, failure), failure);
    } finally {
      this.keep(seat, id);
    }
  }

  private seat(id: string): Seat {
    let seat = this.seats.get(id);
    if (!seat) {
      // Whoever arrives at a screen others are using has not seen what they did to it, and one
      // coming back after its seat expired no longer knows what is there either.
      const expired = this.expired.delete(id);
      seat = {
        shot: null,
        channel: null,
        idleTimer: null,
        expiry: null,
        stale: expired || this.seats.size > 0,
      };
      this.seats.set(id, seat);
    }
    return seat;
  }

  /** After `action` by `seat`, the others no longer know what is on the screen. */
  private changed(seat: Seat, action: ComputerAction): void {
    if (!ACTS.has(action)) return;
    for (const other of this.seats.values()) if (other !== seat) other.stale = true;
  }

  /** The seat's pointer goes; the helper goes with the last seat. */
  private async leave(id: string): Promise<void> {
    const seat = this.seats.get(id);
    if (!seat) return;
    this.seats.delete(id);
    this.clearIdle(seat);
    if (seat.expiry) clearTimeout(seat.expiry);
    seat.expiry = null;
    if (this.channel && seat.channel === this.channel) {
      await this.channel.request({ cmd: 'endSession', ...named(id) }).catch(() => {});
    }
    if (this.seats.size === 0) this.close();
  }

  /** Starts the seat's idle time over. */
  private keep(seat: Seat, id: string): void {
    if (this.seats.get(id) !== seat) return;
    if (seat.expiry) clearTimeout(seat.expiry);
    seat.expiry = setTimeout(() => this.expire(seat, id), this.seatIdleMs);
    seat.expiry.unref();
  }

  /** In the queue, so that it can never land between the steps of an action. */
  private expire(seat: Seat, id: string): void {
    if (this.seats.get(id) !== seat) return;
    if (this.acting > 0) {
      this.keep(seat, id);
      return;
    }
    this.queue = this.queue.then(() => this.leaveIdle(seat, id)).catch(() => {});
  }

  private async leaveIdle(seat: Seat, id: string): Promise<void> {
    if (this.seats.get(id) !== seat) return;
    // An action arrived while this waited its turn: the seat may be the one it is for.
    if (this.acting > 0) {
      this.keep(seat, id);
      return;
    }
    this.expired.add(id);
    if (this.expired.size > EXPIRED_KEPT) {
      for (const oldest of this.expired) {
        this.expired.delete(oldest);
        break;
      }
    }
    // A helper that does not answer would otherwise hold the queue until the next action.
    const stuck = setTimeout(
      () => this.abort('Computer-use helper did not answer.'),
      LEAVE_WAIT_MS,
    );
    stuck.unref();
    try {
      await this.leave(id);
    } finally {
      clearTimeout(stuck);
    }
  }

  private close(): void {
    const channel = this.channel;
    this.channel = null;
    for (const seat of this.seats.values()) this.clearIdle(seat);
    this.platform.release?.();
    channel?.kill();
  }

  private async ensure(
    seat: Seat,
    id: string,
    session: RemoteComputerParams['session'],
  ): Promise<HelperChannel> {
    const channel = this.channel?.alive
      ? this.channel
      : await this.open().catch((error) => {
          // A helper that never started sent nothing to the screen.
          throw refused(messageOf(error), 'failed');
        });
    this.platform.hold?.(channel.pid ?? process.pid);
    if (seat.channel !== channel) {
      await channel.request({
        cmd: 'ensureSession',
        ...named(id),
        ...(session ? { label: session.name, color: session.color } : {}),
      });
      seat.channel = channel;
    }
    this.bumpIdle(seat, id);
    return channel;
  }

  private async open(): Promise<HelperChannel> {
    const channel = new HelperChannel(await this.platform.launch(), () => {
      if (this.channel !== channel) return;
      this.channel = null;
      for (const seat of this.seats.values()) this.clearIdle(seat);
      this.platform.release?.();
    });
    this.channel = channel;
    try {
      await channel.call({ cmd: 'ping' }, 'Computer-use helper did not respond.');
      return channel;
    } catch (error) {
      // A helper that answered wrong is not reused: the next action starts a fresh one.
      this.channel = null;
      channel.kill();
      throw error;
    }
  }

  /**
   * Read again for every screenshot, never kept: the display can change resolution or scale,
   * or another can become primary, while the helper runs.
   */
  private async display(channel: HelperChannel): Promise<DisplayGeometry> {
    const geometry = await channel.call({ cmd: 'geometry' }, 'Could not read display geometry.');
    return {
      originX: Number(geometry.originX) || 0,
      originY: Number(geometry.originY) || 0,
      pointWidth: Number(geometry.pointWidth),
      pointHeight: Number(geometry.pointHeight),
    };
  }

  private async screenshot(
    channel: HelperChannel,
    seat: Seat,
    note: string,
  ): Promise<ActionOutcome> {
    const display = await this.display(channel);
    const shot = await this.platform.capture(channel);
    seat.shot = { ...display, widthPx: shot.widthPx, heightPx: shot.heightPx };
    seat.stale = false;
    return succeeded(
      { widthPx: shot.widthPx, heightPx: shot.heightPx, scale: scaleFromGeometry(seat.shot) },
      { stdout: shot.base64, stderr: note },
    );
  }

  private async input(
    channel: HelperChannel,
    seat: Seat,
    id: string,
    computer: RemoteComputerParams,
  ): Promise<void> {
    const { action } = computer;
    const send = (payload: Record<string, unknown>, failure: string) =>
      channel.call({ ...payload, ...named(id) }, failure);
    switch (action) {
      case 'mouse_move': {
        const at = point(seat, computer.coordinate, 'coordinate is required for this action.');
        await send({ cmd: 'move', ...at }, 'Move failed.');
        return;
      }
      case 'left_click':
      case 'right_click':
      case 'double_click': {
        const at = point(seat, computer.coordinate, 'coordinate is required for this action.');
        const button = action === 'right_click' ? 'right' : 'left';
        const count = action === 'double_click' ? 2 : 1;
        // One request: the helper moves its pointer there, clicks, and restores the user's cursor.
        await send({ cmd: 'clickAt', ...at, button, count }, 'Click failed.');
        return;
      }
      case 'left_click_drag': {
        const missing = 'startCoordinate and coordinate are required for drag.';
        const from = point(seat, computer.startCoordinate, missing);
        const to = point(seat, computer.coordinate, missing);
        await send(
          { cmd: 'drag', fromX: from.pointX, fromY: from.pointY, toX: to.pointX, toY: to.pointY },
          'Drag failed.',
        );
        return;
      }
      case 'type': {
        if (!computer.text) throw refused('text is required for type.');
        await send({ cmd: 'type', text: computer.text }, 'Type failed.');
        return;
      }
      case 'key': {
        if (!computer.key) throw refused('key is required for key.');
        await send({ cmd: 'key', key: computer.key }, 'Key failed.');
        return;
      }
      case 'scroll': {
        const at = point(seat, computer.coordinate, 'coordinate is required for scroll.');
        if (!computer.scrollDirection) throw refused('scrollDirection is required for scroll.');
        await send(
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
        throw refused(`Unsupported computer action: ${action}`);
    }
  }

  private bumpIdle(seat: Seat, id: string): void {
    this.clearIdle(seat);
    seat.idleTimer = setTimeout(() => {
      if (this.channel && seat.channel === this.channel) {
        void this.channel.request({ cmd: 'setIdle', ...named(id) }).catch(() => {});
      }
    }, IDLE_MS);
    seat.idleTimer.unref();
  }

  private clearIdle(seat: Seat): void {
    if (seat.idleTimer) clearTimeout(seat.idleTimer);
    seat.idleTimer = null;
  }
}

/** Which pointer a request is about. The shared seat is the helper's own default: no name. */
function named(id: string): { session?: string } {
  return id === SHARED_SEAT ? {} : { session: id };
}

/** A pixel of the seat's last screenshot as a display point; there must be one, and it must hold it. */
function point(seat: Seat, coordinate: Coordinate | undefined, missing: string): DisplayPoint {
  if (!coordinate) throw refused(missing);
  const shot = seat.shot;
  if (!shot) throw refused('Take a screenshot before using screen coordinates.');
  const [x, y] = coordinate;
  if (x < 0 || y < 0 || x >= shot.widthPx || y >= shot.heightPx) {
    throw refused(
      `Coordinate (${x}, ${y}) is outside the last screenshot (${shot.widthPx}×${shot.heightPx}).`,
    );
  }
  return imagePixelToPoint(x, y, shot);
}
