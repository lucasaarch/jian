import { expect, it } from 'vitest';
import { plainFailure } from './ipc-failure';

it('keeps what the main process said and drops how it travelled', () => {
  const said = 'Reading Safari needs Full Disk Access for Jian, in System Settings';

  expect(
    plainFailure(new Error(`Error invoking remote method 'browser:import-cookies': Error: ${said}`))
      .message,
  ).toBe(said);
  expect(plainFailure(new Error(said)).message).toBe(said);
});
