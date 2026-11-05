import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cappedAppend, fitResult } from '../src/index.ts';

test('cappedAppend stops at the character cap', () => {
  assert.equal(cappedAppend('ab', 'cdef', 4), 'abcd');
});

test('fitResult leaves a small payload alone', () => {
  const input = {
    taskId: '11111111-1111-4111-8111-111111111111',
    exitCode: 0,
    stdout: 'hello',
    stderr: '',
    timedOut: false,
  };
  const { result, body } = fitResult(input, 480_000);
  assert.equal(result.stdout, 'hello');
  assert.equal(JSON.parse(body).stdout, 'hello');
});

test('fitResult truncates oversized stdout so the JSON fits the budget', () => {
  const huge = 'x'.repeat(400_000);
  const input = {
    taskId: '11111111-1111-4111-8111-111111111111',
    exitCode: 0,
    stdout: huge,
    stderr: 'y'.repeat(50_000),
    timedOut: false,
  };
  const budget = 100_000;
  const { result, body } = fitResult(input, budget);
  assert.ok(Buffer.byteLength(body) <= budget);
  assert.ok(result.stdout.length < huge.length);
  assert.match(result.stdout, /truncated to fit the gateway size limit/);
});

test('fitResult can drop payloads entirely when even truncated text is too large', () => {
  const input = {
    taskId: '11111111-1111-4111-8111-111111111111',
    exitCode: 1,
    stdout: 'z'.repeat(50_000),
    stderr: 'e'.repeat(20_000),
    timedOut: false,
  };
  const budget = 400;
  const { result, body } = fitResult(input, budget);
  assert.ok(Buffer.byteLength(body) <= budget);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /exceeded the gateway size limit/);
});

test("fitResult sends the app's browser answer, however large, to the gateway", () => {
  const taskId = '11111111-1111-4111-8111-111111111111';
  const base = { taskId, exitCode: 0, stdout: '', stderr: '', timedOut: false };
  // `check` answers with an empty object: watching, nothing done. It must still arrive.
  assert.deepEqual(JSON.parse(fitResult({ ...base, browser: {} }).body).browser, {});
  const screenshot = 'p'.repeat(2_000_000);
  const acted = { url: 'https://example.com/', screenshot };
  const { body } = fitResult({ ...base, browser: { acted } }, 480_000);
  assert.deepEqual(JSON.parse(body).browser, { acted });
  assert.equal(JSON.parse(body).stderr, '');
});
