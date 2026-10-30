import { describe, expect, it } from 'vitest';
import { placeWindow, readState } from '../src/main/window-place';

const minimum = { width: 720, height: 520 };
const laptop = { x: 0, y: 25, width: 1512, height: 920 };
const external = { x: 1512, y: 0, width: 2560, height: 1415 };
const left = { x: 1700, y: 100, width: 1200, height: 800, maximized: false, fullScreen: false };

describe('where the window opens again', () => {
  it('opens where it was left while that screen is there', () => {
    expect(placeWindow(left, [laptop, external], minimum)).toEqual({
      x: 1700,
      y: 100,
      width: 1200,
      height: 800,
    });
  });

  it('keeps its size but lets the system place it when its screen is gone', () => {
    expect(placeWindow(left, [laptop], minimum)).toEqual({ width: 1200, height: 800 });
    expect(placeWindow({ ...left, width: 2400, height: 1300 }, [laptop], minimum)).toEqual({
      width: 1512,
      height: 920,
    });
  });

  it('opens as a new window would with nothing saved, or something unreadable', () => {
    expect(placeWindow(undefined, [laptop], minimum)).toEqual({});
    expect(readState({ x: 'left', y: 0, width: 800, height: 600 })).toBeUndefined();
    expect(readState(null)).toBeUndefined();
  });
});
