import { createHash } from 'node:crypto';
import { type LanguageModel, type LanguageModelMiddleware, wrapLanguageModel } from 'ai';
import sharp from 'sharp';

type Params = Parameters<NonNullable<LanguageModelMiddleware['transformParams']>>[0]['params'];
type Message = Params['prompt'][number];
type FileData = { type: string; data?: unknown };

/**
 * The longest side an image is sent with, in pixels. Anthropic refuses the whole request, not the
 * image, past 8000 px, and past 2000 px once a request carries more than 20 images, which a long
 * conversation with screenshots does. It is also the size Anthropic documents scaling a larger
 * image down to before the model reads it, so the larger copy mostly cost bytes.
 */
export const MAX_IMAGE_SIDE = 1568;

/** The formats scaled: the ones sharp writes back as it read them, so the media type holds. */
const FORMATS = new Set(['jpeg', 'png', 'webp', 'gif']);

/**
 * Scaled copies kept, as base64 by the hash of the original. An image stays in the history and
 * is sent again at every step: without this each step would scale it again.
 */
const KEPT = 32;
const scaled = new Map<string, Promise<string>>();

/**
 * The image scaled to fit, in its own format, or undefined when it already fits or cannot be
 * read. Unreadable bytes go on as they are: the provider's refusal says more than a guess here.
 * The same bytes always give the same answer, which the provider's prompt cache depends on.
 */
async function fitted(bytes: Buffer): Promise<string | undefined> {
  try {
    const { width = 0, height = 0, format } = await sharp(bytes).metadata();

    if (Math.max(width, height) <= MAX_IMAGE_SIDE || !FORMATS.has(format)) return undefined;

    const key = createHash('sha256').update(bytes).digest('base64');
    let answer = scaled.get(key);

    if (!answer) {
      // Scaling drops the EXIF orientation, so it is applied to the pixels first.
      answer = sharp(bytes)
        .autoOrient()
        .resize({ width: MAX_IMAGE_SIDE, height: MAX_IMAGE_SIDE, fit: 'inside' })
        .toBuffer()
        .then((smaller) => smaller.toString('base64'));
      scaled.set(key, answer);
      if (scaled.size > KEPT) scaled.delete(scaled.keys().next().value as string);
    }

    return await answer;
  } catch {
    return undefined;
  }
}

/** A file part with its image scaled to fit, or the same part when there is nothing to scale. */
async function fitPart<T>(part: T): Promise<T> {
  const file = part as { type?: unknown; mediaType?: unknown; data?: FileData };

  if (file.type !== 'file' || typeof file.mediaType !== 'string') return part;
  if (file.mediaType !== 'image' && !file.mediaType.startsWith('image/')) return part;
  if (file.data?.type !== 'data') return part;

  const data = file.data.data;
  const bytes =
    typeof data === 'string'
      ? Buffer.from(data, 'base64')
      : data instanceof Uint8Array
        ? Buffer.from(data)
        : undefined;
  const smaller = bytes ? await fitted(bytes) : undefined;

  return smaller ? { ...part, data: { type: 'data', data: smaller } } : part;
}

async function fitParts<T>(parts: readonly T[]): Promise<T[]> {
  const next = await Promise.all(parts.map(fitPart));

  return next.some((part, index) => part !== parts[index]) ? next : (parts as T[]);
}

async function fitMessage(message: Message): Promise<Message> {
  if (typeof message.content === 'string') return message;

  const content = await Promise.all(
    message.content.map(async (part) => {
      const fit = await fitPart(part);

      if (fit.type !== 'tool-result' || fit.output.type !== 'content') return fit;

      const value = await fitParts(fit.output.value);

      return value === fit.output.value ? fit : { ...fit, output: { ...fit.output, value } };
    }),
  );

  return content.some((part, index) => part !== message.content[index])
    ? ({ ...message, content } as Message)
    : message;
}

/**
 * Every image of a request scaled to what the provider takes, wherever it came from: an
 * attachment, a screenshot in a tool result, or one stored at full size by an older turn. Done as
 * the request leaves, so no path that builds messages can send one too large and lose the run.
 */
export function withFittedImages(model: LanguageModel): LanguageModel {
  if (typeof model === 'string') return model;

  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: 'v4',
      transformParams: async ({ params }) => {
        const prompt = await Promise.all(params.prompt.map(fitMessage));

        return prompt.some((message, index) => message !== params.prompt[index])
          ? { ...params, prompt }
          : params;
      },
    },
  });
}
