import { describe, expect, it } from 'vitest';
import { type Asked, wheelReader } from './wheel';

/** Events 16 ms apart, as a trackpad sends them, from `start`; each is `[deltaX, deltaY]`. */
function turned(
  read: ReturnType<typeof wheelReader>,
  deltas: readonly (readonly [number, number])[],
  start = 0,
  deltaMode = 0,
): Asked[] {
  return deltas.map(([deltaX, deltaY], index) =>
    read({ deltaX, deltaY, deltaMode, timeStamp: start + index * 16 }),
  );
}

const steps = (asked: readonly Asked[]) => asked.reduce((sum, one) => sum + one.step, 0);
const reader = () => wheelReader(() => 800);

describe('a wheel over the slides', () => {
  it('steps one slide for a vertical swipe, the same forward and back', () => {
    const swipe = (sign: number) =>
      // The fingers, then the long coast a trackpad sends after they left.
      [...Array(6).fill([0, 12 * sign]), ...Array(20).fill([0, 3 * sign])] as [number, number][];

    const forward = turned(reader(), swipe(1));
    const back = turned(reader(), swipe(-1));

    expect(steps(forward)).toBe(1);
    expect(steps(back)).toBe(-1);
    expect(back.map((one) => one.step)).toEqual(forward.map((one) => -one.step || 0));
  });

  it('leaves a sideways swipe to the track, whichever way it drifts vertically', () => {
    for (const sideways of [30, -30]) {
      for (const drift of [9, -9]) {
        const asked = turned(reader(), [
          [sideways / 10, drift / 3],
          ...Array(12).fill([sideways, drift]),
          // The end of the coast, where the drift is as large as the swipe.
          ...Array(12).fill([Math.sign(sideways), drift / 3]),
        ]);

        expect(steps(asked)).toBe(0);
        expect(asked.at(-1)?.axis).toBe('x');
      }
    }
  });

  it('never hands a vertical swipe’s sideways drift to the track', () => {
    for (const vertical of [14, -14]) {
      for (const drift of [5, -5]) {
        const asked = turned(reader(), [
          [0, vertical],
          ...Array(8).fill([drift, vertical]),
          // Coasting, with an event that goes sideways alone.
          [drift, 0],
          ...Array(8).fill([drift / 5, vertical / 7]),
        ]);

        expect(asked.every((one) => one.axis === 'y')).toBe(true);
        expect(steps(asked)).toBe(Math.sign(vertical));
      }
    }
  });

  it('says nothing of a turn until it knows which way it goes', () => {
    const read = reader();

    expect(read({ deltaX: 1, deltaY: 1, deltaMode: 0, timeStamp: 0 })).toEqual({
      axis: undefined,
      step: 0,
    });
    expect(read({ deltaX: -1, deltaY: -9, deltaMode: 0, timeStamp: 16 }).axis).toBe('y');
  });

  it('steps once a notch for a mouse wheel, in pixels, lines or pages', () => {
    for (const [deltaMode, notch] of [
      [0, 100],
      [1, 3],
      [2, 1],
    ] as const) {
      const read = reader();
      const at = (timeStamp: number, deltaY: number) =>
        read({ deltaX: 0, deltaY, deltaMode, timeStamp }).step;

      expect(at(0, notch)).toBe(1);
      expect(at(400, notch)).toBe(1);
      expect(at(800, -notch)).toBe(-1);
      expect(at(1200, -notch)).toBe(-1);
    }
  });

  it('steps again for a wheel that keeps turning, and for a new turn after a pause', () => {
    const read = reader();
    const held = turned(read, Array(60).fill([0, 10]));
    // Sixty events are 944 ms of turning: one step at once, one more 700 ms later.
    expect(steps(held)).toBe(2);

    const next = turned(read, Array(4).fill([0, -10]), 944 + 200);
    expect(steps(next)).toBe(-1);
  });

  it('follows a hand that turns the other way before the last swipe has stopped coasting', () => {
    const read = reader();
    const vertical = turned(read, [...Array(5).fill([0, 12]), ...Array(10).fill([0, 2])]);
    expect(steps(vertical)).toBe(1);

    const sideways = turned(read, Array(6).fill([-25, 1]), 15 * 16);
    expect(sideways.every((one) => one.axis === 'x')).toBe(true);

    const again = turned(read, Array(6).fill([1, -20]), 21 * 16);
    expect(again[0]?.axis).toBe('y');
    expect(steps(again)).toBe(-1);
  });
});
