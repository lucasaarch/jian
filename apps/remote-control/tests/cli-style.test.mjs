import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatSuccessBlock, shouldColorize, stripAnsi } from '../bin/jian-remote.mjs';

test('shouldColorize is false when NO_COLOR is set', () => {
  assert.equal(shouldColorize({ isTTY: true, noColor: '', forceColor: undefined }), true);
  assert.equal(shouldColorize({ isTTY: true, noColor: '1', forceColor: undefined }), false);
  assert.equal(shouldColorize({ isTTY: false, noColor: undefined, forceColor: undefined }), false);
  assert.equal(shouldColorize({ isTTY: false, noColor: undefined, forceColor: '1' }), true);
});

test('formatSuccessBlock uses a clear headline and indented facts without color when disabled', () => {
  const text = formatSuccessBlock({
    headline: 'Installed Jian Remote',
    facts: [
      ['Service', 'LaunchAgent started'],
      ['Config', '/Users/lucas/.config/jian-remote/config.json'],
    ],
    color: false,
  });
  assert.match(text, /^✓ Installed Jian Remote\n/);
  assert.match(text, / {2}Service\s+LaunchAgent started/);
  assert.match(text, / {2}Config\s+\/Users\/lucas\/\.config\/jian-remote\/config\.json/);
  assert.equal(stripAnsi(text), text);
});

test('formatSuccessBlock adds ANSI when color is enabled and stripAnsi removes it', () => {
  const text = formatSuccessBlock({
    headline: 'Updated Jian Remote',
    facts: [['Version', '0.7.2']],
    color: true,
  });
  assert.match(text, new RegExp(`${String.fromCharCode(27)}\\[\\d+m`));
  assert.equal(stripAnsi(text).startsWith('✓ Updated Jian Remote'), true);
  assert.match(stripAnsi(text), /Version\s+0\.7\.2/);
});
