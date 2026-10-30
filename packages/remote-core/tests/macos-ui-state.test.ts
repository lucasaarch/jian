import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAC_UI_STATES, probeMacUiState } from '../src/computer/macos.ts';

test('MAC_UI_STATES lists the contract values', () => {
  assert.deepEqual([...MAC_UI_STATES].sort(), ['display_asleep', 'locked', 'unknown', 'unlocked']);
});

test('probeMacUiState is unknown off darwin (this CI host)', () => {
  if (process.platform === 'darwin') return;
  assert.equal(probeMacUiState({ force: true }), 'unknown');
});
