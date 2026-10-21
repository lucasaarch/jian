import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareComputerUi } from '../bin/computer-macos.mjs';

test('prepareComputerUi never soft-blocks (unknown off darwin)', () => {
  if (process.platform === 'darwin') return;
  const gate = prepareComputerUi();
  assert.equal(gate.sessionLocked, false);
  assert.equal(gate.state, 'unknown');
  assert.equal('blocked' in gate, false);
});
