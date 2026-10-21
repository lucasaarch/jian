import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  compatibilityError,
  isDevVersion,
  parseRelease,
  versionsCompatible,
} from '../bin/jian-remote.mjs';

test('parseRelease reads major.minor.patch and prerelease', () => {
  assert.deepEqual(parseRelease('v0.6.0-rc.5'), {
    major: 0,
    minor: 6,
    patch: 0,
    prerelease: 'rc.5',
    raw: '0.6.0-rc.5',
  });
  assert.equal(parseRelease('not-a-version'), null);
});

test('isDevVersion treats placeholders as development builds', () => {
  assert.equal(isDevVersion('0.0.0-dev'), true);
  assert.equal(isDevVersion(undefined), true);
  assert.equal(isDevVersion('0.6.0'), false);
});

test('versionsCompatible requires the same major.minor for released builds', () => {
  assert.equal(versionsCompatible('0.6.0', '0.6.1').ok, true);
  assert.equal(versionsCompatible('0.6.0-rc.5', '0.6.0').ok, true);
  assert.equal(versionsCompatible('0.6.0', '0.7.0').ok, false);
  assert.equal(versionsCompatible('1.0.0', '0.6.0').ok, false);
});

test('versionsCompatible skips the gate when the gateway has no release version', () => {
  assert.equal(versionsCompatible('0.6.0', undefined).ok, true);
  assert.equal(versionsCompatible('0.6.0', undefined).skipped, true);
  assert.equal(versionsCompatible('0.0.0-dev', '0.0.0-dev').ok, true);
});

test('versionsCompatible rejects a dev worker against a released gateway', () => {
  const result = versionsCompatible('0.0.0-dev', '0.6.0');
  assert.equal(result.ok, false);
  assert.match(result.message, /npx @jian-ai\/remote-control@0\.6\.0 update/);
});

test('compatibilityError returns English guidance for a major.minor mismatch', () => {
  const message = compatibilityError('0.5.2', '0.6.0');
  assert.match(message, /incompatible with gateway 0\.6\.0/);
  assert.match(message, /same major\.minor \(0\.6\)/);
  assert.match(message, /self-update to the gateway version automatically/);
  assert.match(message, /npx @jian-ai\/remote-control@0\.6\.0 update/);
  assert.equal(compatibilityError('0.6.2', '0.6.0'), null);
});
