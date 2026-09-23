import { expect, it } from 'vitest';
import { channelLog } from '../src/channels/logging.js';

it('records channel failures without serializing error contents or arbitrary fields', () => {
  const lines: string[] = [];
  const sensitive = {
    message: 'private chat text',
    token: 'synthetic-secret',
    bytes: Buffer.from('private-key'),
    statusCode: 503,
    code: 'ECONNRESET',
  };
  const details = {
    channelId: '11111111-1111-4111-8111-111111111111',
    deliveryId: 'private-recipient',
    ...sensitive,
  };
  channelLog('dispatch.failed', details, sensitive, (line) => lines.push(line));
  expect(JSON.parse(lines[0] ?? '')).toEqual({
    level: 50,
    time: expect.any(Number),
    component: 'channels',
    event: 'dispatch.failed',
    channelId: details.channelId,
    statusCode: 503,
    errorCode: 'ECONNRESET',
  });
});

it('records an uncertain delivery without exposing the remote recipient', () => {
  const lines: string[] = [];
  channelLog(
    'delivery.result',
    { deliveryId: '11111111-1111-4111-8111-111111111111', status: 'unknown' },
    undefined,
    (line) => lines.push(line),
  );
  expect(JSON.parse(lines[0] ?? '')).toMatchObject({
    level: 40,
    event: 'delivery.result',
    status: 'unknown',
  });
});
