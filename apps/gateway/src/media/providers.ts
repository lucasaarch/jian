import {
  type InlineMedia,
  inlineMediaSchema,
  MAX_MEDIA_BYTES,
  type ModelConfig,
} from '@jian/contracts';
import { z } from 'zod';
import { speechVoice, speechVoices } from './voices.js';

export type MediaUsage = { inputTokens: number; outputTokens: number; cachedInputTokens: number };
export type MediaMeter = (usage: MediaUsage) => Promise<void>;
const usageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative().default(0),
});

async function meter(body: unknown, google: boolean, account?: MediaMeter) {
  if (!account || !body || typeof body !== 'object') return;
  const value = body as Record<string, unknown>;
  const reported = (google ? value.usageMetadata : value.usage) as
    | Record<string, unknown>
    | undefined;
  if (!reported) return;
  const parsed = usageSchema.safeParse(
    google
      ? {
          inputTokens: reported.promptTokenCount,
          outputTokens:
            Number(reported.candidatesTokenCount ?? 0) + Number(reported.thoughtsTokenCount ?? 0),
          cachedInputTokens: reported.cachedContentTokenCount ?? 0,
        }
      : { inputTokens: reported.input_tokens, outputTokens: reported.output_tokens },
  );
  if (parsed.success) await account(parsed.data);
}

const googleResponse = z.object({
  candidates: z
    .array(
      z.object({
        content: z
          .object({
            parts: z.array(
              z.object({
                text: z.string().optional(),
                inlineData: z.object({ mimeType: z.string(), data: z.string() }).optional(),
              }),
            ),
          })
          .optional(),
      }),
    )
    .optional(),
});

/** Reads the body with a ceiling even when the remote server omits Content-Length. */
export async function readMediaBody(
  response: Response,
  limit = MAX_MEDIA_BYTES * 2,
): Promise<Buffer> {
  if (!response.body) throw new Error('Media provider returned an empty body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) throw new Error('Media exceeds the 16 MB limit');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}

function wav(pcm: Buffer, rate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF');
  header.writeUInt32LE(pcm.length + 36, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Pauses before asking a busy provider again. */
const RETRY_PAUSES_MS = [1_000, 3_000];

export class MediaProviders {
  constructor(
    private readonly fetcher: typeof fetch,
    private readonly pauses: readonly number[] = RETRY_PAUSES_MS,
  ) {}

  /**
   * A 5xx is the provider busy, not the request wrong — Gemini answers 503 when a model is
   * overloaded — so it is asked again, twice, after a growing pause. A body sent as a stream
   * cannot be sent twice, but every request here sends a string or a form, which can.
   */
  private async request(url: string, options: RequestInit) {
    let response = await this.fetcher(url, options);
    for (const pause of this.pauses) {
      if (response.status < 500 || options.signal?.aborted) break;
      await response.body?.cancel();
      await new Promise((resolve) => setTimeout(resolve, pause));
      response = await this.fetcher(url, options);
    }
    if (!response.ok) {
      await response.body?.cancel();
      // Provider error bodies can echo credentials or private media.
      const hint =
        response.status === 429
          ? ': rate limit or quota exhausted; check provider billing and limits'
          : response.status === 404
            ? ': model unavailable; choose another model in Model defaults'
            : '';
      throw new Error(`Media provider answered HTTP ${response.status}${hint}`);
    }
    return response;
  }

  private async google(
    config: ModelConfig,
    key: string,
    parts: unknown[],
    generationConfig: unknown,
    signal: AbortSignal,
    account?: MediaMeter,
  ) {
    const response = await this.request(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(config.modelId)}:generateContent`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig }),
        signal,
      },
    );
    const body: unknown = JSON.parse((await readMediaBody(response)).toString('utf8'));
    await meter(body, true, account);
    const result = googleResponse.parse(body);
    return result.candidates?.[0]?.content?.parts ?? [];
  }

  async analyze(
    config: ModelConfig,
    key: string,
    media: InlineMedia,
    prompt: string,
    signal: AbortSignal,
    account?: MediaMeter,
  ): Promise<string> {
    if (config.provider === 'google') {
      const parts = await this.google(
        config,
        key,
        [{ text: prompt }, { inlineData: { mimeType: media.mimeType, data: media.data } }],
        { maxOutputTokens: 8192 },
        signal,
        account,
      );
      const text = parts
        .map((part) => part.text ?? '')
        .join('\n')
        .trim();
      if (!text) throw new Error('Media provider did not return an analysis');
      return text;
    }
    const transcribes =
      config.provider === 'openai' || (config.provider === 'openai-compatible' && config.baseURL);
    if (transcribes && media.mimeType.startsWith('audio/')) {
      const form = new FormData();
      form.set('model', config.modelId);
      const extension =
        media.mimeType.split('/')[1] === 'mpeg' ? 'mp3' : media.mimeType.split('/')[1];
      form.set(
        'file',
        new Blob([new Uint8Array(Buffer.from(media.data, 'base64'))], { type: media.mimeType }),
        `audio.${extension}`,
      );
      // The same endpoint at OpenAI, at Groq, or on a Whisper server the owner runs.
      const base =
        config.provider === 'openai-compatible' ? config.baseURL : 'https://api.openai.com/v1';
      const response = await this.request(`${base}/audio/transcriptions`, {
        method: 'POST',
        headers: key ? { authorization: `Bearer ${key}` } : {},
        body: form,
        signal,
      });
      return z
        .object({ text: z.string().min(1) })
        .parse(JSON.parse((await readMediaBody(response, 100_000)).toString())).text;
    }
    throw new Error(
      'Select Gemini for audio analysis, or a Whisper model from OpenAI, Groq or your own server',
    );
  }

  async generate(
    kind: 'image' | 'speech',
    config: ModelConfig,
    key: string,
    prompt: string,
    voice: string | undefined,
    signal: AbortSignal,
    account?: MediaMeter,
    instructions?: string,
  ): Promise<InlineMedia> {
    if (config.provider === 'openai-codex')
      throw new Error('Image and speech generation require an OpenAI API key, not a ChatGPT login');
    const selectedVoice = kind === 'speech' ? speechVoice(config, voice) : undefined;
    if (kind === 'speech' && instructions && !speechVoices(config).supportsInstructions)
      throw new Error(
        'This speech model does not support style instructions. Omit instructions or choose a newer speech model.',
      );
    if (config.provider === 'google') {
      const parts = await this.google(
        config,
        key,
        [
          {
            text:
              kind === 'speech' && instructions
                ? `Speaking style: ${instructions}\nRead only the following text aloud, without reading these instructions:\n${prompt}`
                : prompt,
          },
        ],
        kind === 'image'
          ? { responseModalities: ['TEXT', 'IMAGE'] }
          : {
              responseModalities: ['AUDIO'],
              speechConfig: {
                voiceConfig: { prebuiltVoiceConfig: { voiceName: selectedVoice } },
              },
            },
        signal,
        account,
      );
      const result = parts.find((part) =>
        part.inlineData?.mimeType.startsWith(kind === 'image' ? 'image/' : 'audio/'),
      )?.inlineData;
      if (!result)
        throw new Error(`Media provider did not return ${kind === 'image' ? 'an image' : 'audio'}`);
      if (result.mimeType.startsWith('audio/L16')) {
        const rate = Number(/rate=(\d+)/.exec(result.mimeType)?.[1] ?? 24000);
        if (rate < 8000 || rate > 96000) throw new Error('Unsupported speech sample rate');
        return {
          mimeType: 'audio/wav',
          data: wav(Buffer.from(result.data, 'base64'), rate).toString('base64'),
          voice: true,
        };
      }
      return inlineMediaSchema.parse({ ...result, ...(kind === 'speech' ? { voice: true } : {}) });
    }
    if (config.provider !== 'openai')
      throw new Error('Select an OpenAI API or Gemini model for media generation');
    const response = await this.request(
      `https://api.openai.com/v1/${kind === 'image' ? 'images/generations' : 'audio/speech'}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        signal,
        body: JSON.stringify(
          kind === 'image'
            ? {
                model: config.modelId,
                prompt,
                n: 1,
                ...(config.modelId.startsWith('dall-e') ? { response_format: 'b64_json' } : {}),
              }
            : {
                model: config.modelId,
                input: prompt,
                voice: selectedVoice,
                ...(instructions ? { instructions } : {}),
                response_format: 'opus',
              },
        ),
      },
    );
    const data = await readMediaBody(response);
    if (kind === 'speech')
      return { mimeType: 'audio/ogg', data: data.toString('base64'), voice: true };
    const body: unknown = JSON.parse(data.toString());
    await meter(body, false, account);
    const parsed = z
      .object({ data: z.array(z.object({ b64_json: z.string().min(1) })).min(1) })
      .parse(body);
    return { mimeType: 'image/png', data: parsed.data[0]?.b64_json ?? '' };
  }
}
