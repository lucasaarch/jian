import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { DateTimeField } from './date-time-field';

let element: HTMLDivElement;
let root: Root;
let written: string[];

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  element = document.createElement('div');
  document.body.append(element);
  root = createRoot(element);
  written = [];
});

afterEach(async () => {
  await act(async () => root.unmount());
  element.remove();
});

function Field({ initial, min }: { initial: string; min?: string }) {
  const [value, setValue] = useState(initial);
  return (
    <DateTimeField
      label="Date and time"
      value={value}
      {...(min ? { min } : {})}
      onChange={(next) => {
        written.push(next);
        setValue(next);
      }}
    />
  );
}

const open = () => act(async () => element.querySelector<HTMLButtonElement>('button')?.click());
const press = (name: string) =>
  act(async () => document.querySelector<HTMLButtonElement>(`[aria-label="${name}"]`)?.click());
const day = (name: string) => document.querySelector<HTMLButtonElement>(`[aria-label="${name}"]`);

it('writes the day and time picked as datetime-local does, keeping the part not changed', async () => {
  await act(async () => root.render(<Field initial="2026-11-03T15:25" />));
  expect(element.textContent).toContain('Tue, Nov 3, 2026 at 15:25');

  await open();
  await press('Thursday, November 12, 2026');
  await press('Hour 08');
  await press('Minute 05');

  expect(written).toEqual(['2026-11-12T15:25', '2026-11-12T08:25', '2026-11-12T08:05']);
  expect(element.textContent).toContain('Thu, Nov 12, 2026 at 08:05');
});

it('starts a time picked before any day on the earliest day, and keeps earlier days out of reach', async () => {
  await act(async () => root.render(<Field initial="" min="2026-10-30T14:10" />));
  expect(element.textContent).toContain('Not set');

  await open();
  expect(day('Thursday, October 29, 2026')?.disabled).toBe(true);
  expect(day('Friday, October 30, 2026')?.disabled).toBe(false);
  expect(day('Previous month')?.disabled).toBe(true);

  await press('Minute 30');
  expect(written).toEqual(['2026-10-30T09:30']);
});
