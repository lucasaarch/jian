import { MAX_MESSAGE_MEDIA } from '@jian/contracts';
import type { ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { mediaIdsIn } from '../src/media/repository.js';
import { testServices } from './helpers/services.js';

const token = 'synthetic-uploads-admin-token-32-chars';
const admin = { authorization: `Bearer ${token}` };
const base64 = (text: string) => Buffer.from(text).toString('base64');

async function setup() {
  const services = await testServices();
  const input = {
    instructions: 'Help.',
    model: { provider: 'openai' as const, modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
  };
  const profile = await services.profiles.createProfile({ ...input, name: 'Owner' });
  const other = await services.profiles.createProfile({ ...input, name: 'Other' });
  const gateway = await services.sessions.gatewaySession(profile.id);
  const app = createApp({ ...services, token, logger: false });
  const upload = (profileId: string, sessionId: string, payload: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: `/v1/profiles/${profileId}/sessions/${sessionId}/media`,
      headers: admin,
      payload,
    });

  return { services, profile, other, gateway, app, upload };
}

describe('attaching files to a message', () => {
  it('sends attachments alone, and puts a text document in front of the agent by name', async () => {
    const f = await setup();

    try {
      // Past the 256 KB every other route accepts: a real document is bigger than a request.
      const notes = `Decisões da release\n${'linha de nota\n'.repeat(25_000)}`;
      const uploaded = await f.upload(f.profile.id, f.gateway.id, {
        mimeType: 'text/plain',
        name: 'Pasted Content.txt',
        data: base64(notes),
      });

      expect(uploaded.statusCode).toBe(201);
      const media = uploaded.json();

      expect(media).toMatchObject({ mimeType: 'text/plain', name: 'Pasted Content.txt' });

      const run = await f.services.runs.submit(f.profile.id, f.gateway.id, {
        text: '',
        mediaIds: [media.id],
        requestKey: 'attachment-only',
      });

      expect(mediaIdsIn(run.input)).toEqual([media.id]);

      const messages: ModelMessage[] = [{ role: 'user', content: run.input }];

      await f.services.media.prepare(messages, run, AbortSignal.timeout(1000));

      const parts = messages[0]?.content as Array<{ type: string; text?: string }>;
      const document = parts.find((part) => part.text?.includes('Pasted Content.txt'));

      expect(document?.text).toContain('Decisões da release');
      expect(document?.text).toContain('[Cut here');
    } finally {
      await f.app.close();
    }
  });

  it('keeps an upload inside its profile', async () => {
    const f = await setup();

    try {
      // Into another profile's conversation: that conversation does not exist for this caller.
      expect(
        (await f.upload(f.other.id, f.gateway.id, { mimeType: 'text/plain', data: base64('x') }))
          .statusCode,
      ).toBe(404);

      const media = (
        await f.upload(f.profile.id, f.gateway.id, { mimeType: 'text/plain', data: base64('x') })
      ).json();
      const theirs = await f.services.sessions.gatewaySession(f.other.id);

      await expect(
        f.services.runs.submit(f.other.id, theirs.id, {
          text: 'olha',
          mediaIds: [media.id],
          requestKey: 'foreign',
        }),
      ).rejects.toMatchObject({ statusCode: 404 });
    } finally {
      await f.app.close();
    }
  });

  it('refuses a message with neither text nor attachments, and bounds what waits unsent', async () => {
    const f = await setup();

    try {
      await expect(
        f.services.runs.submit(f.profile.id, f.gateway.id, { text: ' ', requestKey: 'empty' }),
      ).rejects.toThrow();

      const waiting = MAX_MESSAGE_MEDIA * 2;

      for (let index = 0; index < waiting; index += 1) {
        const accepted = await f.upload(f.profile.id, f.gateway.id, {
          mimeType: 'text/plain',
          data: base64(`nota ${index}`),
        });

        expect(accepted.statusCode).toBe(201);
      }

      expect(
        (await f.upload(f.profile.id, f.gateway.id, { mimeType: 'text/plain', data: base64('+') }))
          .statusCode,
      ).toBe(429);
    } finally {
      await f.app.close();
    }
  });
});
