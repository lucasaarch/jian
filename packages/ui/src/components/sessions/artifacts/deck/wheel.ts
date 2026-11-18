/** How far a wheel turns, in px, before it is a step to the next slide. */
const TURN = 20;
/** A wheel's line, in px, for a mouse that counts in lines rather than pixels. */
const LINE = 16;
/** A wheel quiet for this long, in ms, has ended its turn: the next event starts another. */
const PAUSE = 150;
/** A wheel still turning this long, in ms, after a step takes another. */
const AGAIN = 700;
/** How far a wheel turns, in px, before its turn is known to be sideways or not. */
const LOCK = 4;
/**
 * How far one event goes the other way, in px and at three times what it goes along the turn's
 * own, before the turn is taken to have changed: a hand that swipes sideways while the last
 * vertical swipe still coasts, with no pause between them.
 */
const SWERVE = 12;

/** What of a `WheelEvent` is read; `deltaMode` is 0 for px, 1 for lines and 2 for pages. */
export type Turn = { deltaX: number; deltaY: number; deltaMode: number; timeStamp: number };

/**
 * What one event asks of the track. `x` is a turn sideways, which is the track's own scroll and
 * left to the browser. `y` is a vertical turn, which scrolls nothing by itself: `step` is the
 * slide to move by, and is 0 for most of its events. With no axis the turn has only begun, and
 * says nothing yet.
 */
export type Asked = { axis: 'x' | 'y' | undefined; step: -1 | 0 | 1 };

/**
 * Reads a wheel one event at a time, for a row of slides. `page` is the row's width in px, for
 * a wheel that counts in pages.
 *
 * A turn keeps to the one axis it began on. A trackpad never moves along one alone: a swipe
 * sideways drifts a little up or down, and a vertical one a little sideways. Read event by
 * event, that drift stepped the deck against a sideways swipe, or scrolled the track under a
 * step on its way and ended it, in whichever direction the hand happens to drift. So the
 * larger of the two decides once, at the start, and the other is ignored until the wheel rests.
 *
 * A vertical turn steps once: a trackpad goes on sending the same swipe long after the fingers
 * left. One that is still turning `AGAIN` ms later steps again.
 */
export function wheelReader(page: () => number): (event: Turn) => Asked {
  let axis: 'x' | 'y' | undefined;
  let x = 0;
  let y = 0;
  let before = Number.NEGATIVE_INFINITY;
  let stepped: number | undefined;

  const begin = (on?: 'x' | 'y') => {
    axis = on;
    x = 0;
    y = 0;
    stepped = undefined;
  };

  return (event) => {
    if (event.timeStamp - before > PAUSE) begin();
    before = event.timeStamp;

    const unit = event.deltaMode === 1 ? LINE : event.deltaMode === 2 ? page() : 1;
    const dx = event.deltaX * unit;
    const dy = event.deltaY * unit;
    const [along, across] = axis === 'x' ? [dx, dy] : [dy, dx];

    if (axis && Math.abs(across) >= SWERVE && Math.abs(across) >= 3 * Math.abs(along)) {
      begin(axis === 'x' ? 'y' : 'x');
    }
    if (!axis) {
      x += dx;
      y += dy;
      if (Math.max(Math.abs(x), Math.abs(y)) < LOCK) return { axis, step: 0 };
      axis = Math.abs(x) >= Math.abs(y) ? 'x' : 'y';
    } else if (axis === 'y') {
      y += dy;
    }
    if (axis === 'x') return { axis, step: 0 };
    if (stepped !== undefined && event.timeStamp - stepped < AGAIN) {
      y = 0;
      return { axis, step: 0 };
    }
    if (Math.abs(y) < TURN) return { axis, step: 0 };

    const step = y > 0 ? 1 : -1;
    y = 0;
    stepped = event.timeStamp;

    return { axis, step };
  };
}
