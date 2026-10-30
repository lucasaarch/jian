import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectGateway } from '../../platform/gateway';
import { panelApi } from './client';

describe('the panel client after the host connects it to another gateway', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends every request to the gateway it was connected to last', async () => {
    const asked: string[] = [];
    vi.stubGlobal('fetch', async (request: Request) => {
      asked.push(new URL(request.url).origin + new URL(request.url).pathname);
      return Response.json([]);
    });
    const connect = (origin: string) =>
      connectGateway({ origin, headers: {}, credentials: 'same-origin' });

    connect('https://first.example');
    await panelApi().profiles();
    connect('https://second.example');
    await panelApi().profiles();

    expect(asked).toEqual([
      'https://first.example/v1/profiles',
      'https://second.example/v1/profiles',
    ]);
  });
});
