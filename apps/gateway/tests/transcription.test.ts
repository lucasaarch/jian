import { supportsModelRole } from '@jian/contracts';
import { expect, it } from 'vitest';
import { MediaProviders } from '../src/media/providers.js';
import { testServices } from './helpers/services.js';

const audio = { mimeType: 'audio/ogg' as const, data: Buffer.from('ogg').toString('base64') };
const signal = AbortSignal.timeout(1000);

it('asks a busy provider again instead of losing the voice note', async () => {
  let calls = 0;
  const client = new MediaProviders(async () => {
    calls++;

    return calls < 3
      ? new Response('overloaded', { status: 503 })
      : Response.json({ candidates: [{ content: { parts: [{ text: 'Call me at five.' }] } }] });
  }, [0, 0]);

  expect(
    await client.analyze(
      { provider: 'google', modelId: 'gemini-3.8-flash' },
      'synthetic-key',
      audio,
      'Transcribe.',
      signal,
    ),
  ).toBe('Call me at five.');
  expect(calls).toBe(3);
});

it('transcribes on a Whisper server the owner runs, without a key', async () => {
  const seen: Array<{ url: string; auth: string | null; model: string }> = [];
  const client = new MediaProviders(async (url, options) => {
    const form = options?.body as FormData;

    seen.push({
      url: String(url),
      auth: new Headers(options?.headers).get('authorization'),
      model: String(form.get('model')),
    });

    return Response.json({ text: 'Call me at five.' });
  }, []);

  const text = await client.analyze(
    {
      provider: 'openai-compatible',
      modelId: 'Systran/faster-whisper-small',
      baseURL: 'http://whisper:8000/v1',
    },
    '',
    audio,
    'Transcribe.',
    signal,
  );

  expect(text).toBe('Call me at five.');
  expect(seen).toEqual([
    {
      url: 'http://whisper:8000/v1/audio/transcriptions',
      auth: null,
      model: 'Systran/faster-whisper-small',
    },
  ]);
});

it('adds Groq with a key, a server with an address, and routes both through the OpenAI API', async () => {
  const services = await testServices();

  await expect(services.providers.createProvider({ name: 'Groq', kind: 'groq' })).rejects.toThrow(
    'API key',
  );
  await expect(
    services.providers.createProvider({ name: 'Whisper', kind: 'openai-compatible' }),
  ).rejects.toThrow('address');

  const groq = await services.providers.createProvider({
    name: 'Groq',
    kind: 'groq',
    secret: 'gsk_synthetic',
  });
  const whisper = await services.providers.createProvider({
    name: 'Whisper',
    kind: 'openai-compatible',
    baseURL: 'http://whisper:8000/v1/',
  });

  const viaGroq = await services.providers.selectedModel(
    { providerId: groq.id, modelId: 'whisper-large-v3-turbo' },
    services.store.db,
  );
  const viaServer = await services.providers.selectedModel(
    { providerId: whisper.id, modelId: 'Systran/faster-whisper-small' },
    services.store.db,
  );

  expect(viaGroq.config).toMatchObject({
    provider: 'openai-compatible',
    baseURL: 'https://api.groq.com/openai/v1',
    providerId: groq.id,
  });
  expect(viaServer.config).toMatchObject({
    provider: 'openai-compatible',
    baseURL: 'http://whisper:8000/v1',
  });

  // Whisper is for incoming audio; the chat models of the same provider are for conversation.
  const model = (id: string) => ({ id, inputModalities: [], outputModalities: [], known: false });

  expect(supportsModelRole(groq, model('whisper-large-v3-turbo'), 'audio')).toBe(true);
  expect(supportsModelRole(groq, model('whisper-large-v3-turbo'), 'conversation')).toBe(false);
  expect(supportsModelRole(groq, model('llama-3.3-70b-versatile'), 'audio')).toBe(false);
  expect(supportsModelRole(whisper, model('Systran/faster-whisper-small'), 'audio')).toBe(true);
});
