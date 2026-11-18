import { createAnthropic } from '@ai-sdk/anthropic';
import { generateText, type ModelMessage } from 'ai';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { MAX_IMAGE_SIDE, withFittedImages } from '../src/agent/model-images.js';

type Source = { type: string; media_type: string; data: string };
type Block = { type: string; source?: Source; content?: Block[] };

const picture = async (width: number, height: number, format: 'png' | 'jpeg') =>
  (
    await sharp({ create: { width, height, channels: 3, background: '#3366cc' } })
      .toFormat(format)
      .toBuffer()
  ).toString('base64');

/** The images Anthropic was sent for `messages`, read from the request the real provider wrote. */
async function sent(messages: ModelMessage[]): Promise<Source[]> {
  let body: { messages: { content: Block[] }[] } | undefined;
  const model = withFittedImages(
    createAnthropic({
      apiKey: 'synthetic-anthropic-key',
      baseURL: 'https://api.anthropic.test/v1',
      fetch: (async (_url: unknown, init: { body: string }) => {
        body = JSON.parse(init.body);
        return Response.json({
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          model: 'claude-test',
          content: [{ type: 'text', text: 'Seen.' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 2 },
        });
      }) as unknown as typeof globalThis.fetch,
    })('claude-test'),
  );

  await generateText({ model, messages, maxRetries: 0 });

  const images = (blocks: Block[]): Source[] =>
    blocks.flatMap((block) => [
      ...(block.type === 'image' && block.source ? [block.source] : []),
      ...images(block.content ?? []),
    ]);

  return (body?.messages ?? []).flatMap((message) => images(message.content));
}

const sizeOf = async (image: Source) => {
  const { width, height, format } = await sharp(Buffer.from(image.data, 'base64')).metadata();
  return { width, height, format };
};

describe('images sent to the provider', () => {
  it('scales an attachment and a tool result image that are too large, keeping their shape', async () => {
    const attachment = await picture(3200, 1600, 'jpeg');
    const screenshot = await picture(1000, 4000, 'png');

    const images = await sent([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is in this?' },
          { type: 'file', data: attachment, mediaType: 'image/jpeg' },
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'call_1', toolName: 'capture', input: {} }],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call_1',
            toolName: 'capture',
            output: {
              type: 'content',
              value: [
                { type: 'text', text: 'Captured.' },
                { type: 'file', data: { type: 'data', data: screenshot }, mediaType: 'image/png' },
              ],
            },
          },
        ],
      },
    ]);

    expect(images.map((image) => image.media_type)).toEqual(['image/jpeg', 'image/png']);
    expect(await Promise.all(images.map(sizeOf))).toEqual([
      { width: MAX_IMAGE_SIDE, height: MAX_IMAGE_SIDE / 2, format: 'jpeg' },
      { width: MAX_IMAGE_SIDE / 4, height: MAX_IMAGE_SIDE, format: 'png' },
    ]);
  });

  it('sends an image that fits, and bytes it cannot read, exactly as they were', async () => {
    const small = await picture(MAX_IMAGE_SIDE, 900, 'png');
    const broken = Buffer.from('not an image at all').toString('base64');

    const images = await sent([
      {
        role: 'user',
        content: [
          { type: 'file', data: small, mediaType: 'image/png' },
          { type: 'file', data: broken, mediaType: 'image/png' },
        ],
      },
    ]);

    expect(images.map((image) => image.data)).toEqual([small, broken]);
  });

  it('gives the same bytes every time, so a cached prompt still matches', async () => {
    const large = await picture(2400, 2400, 'png');
    const turn: ModelMessage[] = [
      { role: 'user', content: [{ type: 'file', data: large, mediaType: 'image/png' }] },
    ];

    const [first] = await sent(turn);
    const [second] = await sent(turn);

    expect(first?.data).toBeTruthy();
    expect(second?.data).toBe(first?.data);
  });
});
