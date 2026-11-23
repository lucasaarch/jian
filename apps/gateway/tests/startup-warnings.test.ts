import { afterEach, expect, it, vi } from 'vitest';
import { withoutTopLevelUnion } from '../src/agent/mcp.js';
import { createApp } from '../src/app.js';
import { testServices } from './helpers/services.js';

afterEach(() => {
  vi.restoreAllMocks();
});

it('starts without the router deprecation or the serializer strict-mode warnings', async () => {
  const said: string[] = [];
  const keep = (...args: unknown[]) => {
    said.push(args.map(String).join(' '));
  };
  vi.spyOn(console, 'warn').mockImplementation(keep);
  vi.spyOn(console, 'error').mockImplementation(keep);
  vi.spyOn(console, 'log').mockImplementation(keep);
  const emitted = vi.spyOn(process, 'emitWarning');

  const app = createApp({
    ...(await testServices()),
    token: 'test-token-that-is-at-least-32-characters',
    logger: false,
  });
  await app.ready();
  await app.close();

  expect(said.filter((line) => line.includes('strict mode'))).toEqual([]);
  expect(emitted.mock.calls.map(([warning]) => String(warning))).not.toContainEqual(
    expect.stringContaining('maxParamLength'),
  );
});

it('sends Anthropic one object for an MCP tool whose schema is a top-level union', () => {
  const flat = withoutTopLevelUnion({
    type: 'object',
    properties: { use: { type: 'string' } },
    required: ['use'],
    oneOf: [
      { type: 'object', properties: { a: { type: 'string' }, kind: {} }, required: ['a', 'kind'] },
      { type: 'object', properties: { b: { type: 'number' }, kind: {} }, required: ['kind'] },
    ],
  });

  expect(flat).toEqual({
    type: 'object',
    properties: { use: { type: 'string' }, a: { type: 'string' }, b: { type: 'number' }, kind: {} },
    required: ['use', 'kind'],
  });
  expect(withoutTopLevelUnion({ allOf: [{ properties: { x: {} }, required: ['x'] }] })).toEqual({
    type: 'object',
    properties: { x: {} },
    required: ['x'],
  });
});
