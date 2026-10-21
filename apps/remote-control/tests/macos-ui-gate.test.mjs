import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computerActionAllowedWhileLocked, prepareComputerUi } from '../bin/computer-macos.mjs';

test('while locked, screenshot/wait/end_session are allowed; input is not', () => {
  assert.equal(computerActionAllowedWhileLocked('screenshot'), true);
  assert.equal(computerActionAllowedWhileLocked('wait'), true);
  assert.equal(computerActionAllowedWhileLocked('end_session'), true);
  assert.equal(computerActionAllowedWhileLocked('left_click'), false);
  assert.equal(computerActionAllowedWhileLocked('type'), false);
  assert.equal(computerActionAllowedWhileLocked('key'), false);
});

test('prepareComputerUi allows screenshot off darwin (unknown state)', () => {
  if (process.platform === 'darwin') return;
  const gate = prepareComputerUi('screenshot');
  assert.equal(gate.blocked, null);
});
