import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cappedAppend, fitResult, keepEnds, OutputEnds } from '../src/index.ts';

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
  assert.match(result.stdout, /of this output were not kept\]/);
});

test('fitResult can drop payloads entirely when even truncated text is too large', () => {
  const input = {
    taskId: '11111111-1111-4111-8111-111111111111',
    exitCode: 1,
    stdout: 'z'.repeat(50_000),
    stderr: 'e'.repeat(20_000),
    timedOut: false,
  };
  // Only the markers fit: they still say how much there was.
  const { result, body } = fitResult(input, 400);
  assert.ok(Buffer.byteLength(body) <= 400);
  assert.doesNotMatch(result.stdout, /zzz/);
  assert.match(result.stdout, /50,000 characters\) of this output were not kept/);
  // Not even those: the payloads go, and the agent is told why.
  const tiny = fitResult(input, 200);
  assert.ok(Buffer.byteLength(tiny.body) <= 200);
  assert.equal(tiny.result.stdout, '');
  assert.match(tiny.result.stderr, /exceeded the gateway size limit/);
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

test('a long output keeps its first and last parts, and says how many lines were left out', () => {
  const ends = new OutputEnds(1_000);
  ends.push('FIRST\n');
  for (let line = 0; line < 500; line++) ends.push(Buffer.from(`line ${line}\n`));
  ends.push('error: the build failed\n');
  const text = ends.text();
  assert.ok(text.length <= 1_000);
  assert.ok(text.startsWith('FIRST\n'));
  assert.ok(text.endsWith('error: the build failed\n'));
  const [, lost] =
    /\[… ([\d,]+) lines \([\d,]+ characters\) of this output were not kept\]/.exec(text) ?? [];
  const kept = text.split('\n').length - 3;
  // What was kept and what was left out add up to every line printed.
  assert.equal(Number(lost?.replaceAll(',', '')) + kept, 502);
});

test('a short output is kept as it is, and a character split between reads is whole', () => {
  const ends = new OutputEnds(1_000);
  const bytes = Buffer.from('São Paulo 😀');
  ends.push(bytes.subarray(0, 2));
  ends.push(bytes.subarray(2, 13));
  ends.push(bytes.subarray(13));
  assert.equal(ends.text(), 'São Paulo 😀');
});

test('cutting again folds what was already left out into one marker, and splits no character', () => {
  const ends = new OutputEnds(1_000);
  for (let line = 0; line < 300; line++) ends.push(`${'😀'.repeat(3)} ${line}\n`);
  const once = ends.text();
  const twice = keepEnds(once, 400);
  assert.ok(twice.length <= 400);
  assert.equal(twice.match(/were not kept/g)?.length, 1);
  assert.doesNotMatch(
    twice,
    /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/,
  );
  const lost = (text: string) =>
    Number(/\(([\d,]+) characters\)/.exec(text)?.[1]?.replaceAll(',', '') ?? 0);
  assert.ok(lost(twice) > lost(once));
});
