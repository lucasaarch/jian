import type { ApiMethods, ApiResponse } from '@grammyjs/types';
import type { InlineMedia } from '@jian/contracts';
import { fileNameOf, MAX_MEDIA_BYTES, mediaMimeOf, telegramUpdateSchema } from '@jian/contracts';
import { z } from 'zod';
import { readMediaBody } from '../media/providers.js';
import type {
  Channel,
  DeliveryContext,
  DeliveryOutcome,
  IncomingMessage,
  OutgoingMessage,
} from './channel.js';

const MESSAGE_CHUNK_SIZE = 4000;
const REQUEST_TIMEOUT_MS = 15_000;
const TYPING_TIMEOUT_MS = 1500;
/** Telegram asks for a wait it chooses; this only stops a wrong answer from parking the bot. */
const MAX_COOLDOWN_MS = 60_000;
/** What to wait when Telegram refuses for flood control without saying for how long. */
const DEFAULT_COOLDOWN_MS = 5_000;

/** Telegram calls a room a group until it is upgraded; both carry the same message shape. */
const GROUP_CHATS = new Set(['group', 'supergroup']);

const BOT_TOKEN = /^\d+:[A-Za-z0-9_-]+$/;
/** A 16 MB file on a slow link; the webhook waits for it before it answers. */
const FILE_TIMEOUT_MS = 60_000;

type TelegramMessage = NonNullable<z.infer<typeof telegramUpdateSchema>['message']>;

/**
 * The one file a message carries, with what the gateway stores it as. Telegram sends a photo in
 * several sizes and names only documents; the rest take their type from the kind of message.
 */
function fileOf(message: TelegramMessage) {
  const photo = message.photo?.at(-1);
  if (photo) return { ...photo, mimeType: 'image/jpeg', label: '[Photo]' } as const;
  if (message.voice)
    return {
      ...message.voice,
      mimeType: 'audio/ogg',
      voice: true,
      label: '[Voice message]',
    } as const;
  if (message.video_note)
    return { ...message.video_note, mimeType: 'video/mp4', label: '[Video message]' } as const;
  const file = message.document ?? message.audio ?? message.video;
  if (!file) return undefined;
  const name = file.file_name?.trim().slice(0, 200) || undefined;

  return {
    ...file,
    mimeType: mediaMimeOf(file.mime_type, name),
    ...(name ? { name } : {}),
    label: name ? `[File: ${name}]` : '[Media attachment]',
  } as const;
}

/** How the Bot API sends each kind of file, and the form field it expects it in. */
function sendMethodOf(media: InlineMedia) {
  if (media.mimeType.startsWith('image/') && media.mimeType !== 'image/gif')
    return { method: 'sendPhoto', field: 'photo' } as const;
  if (media.mimeType === 'audio/ogg' && !media.name)
    return { method: 'sendVoice', field: 'voice' } as const;
  if (media.mimeType.startsWith('video/')) return { method: 'sendVideo', field: 'video' } as const;
  if (media.mimeType.startsWith('audio/') && !media.name)
    return { method: 'sendAudio', field: 'audio' } as const;
  return { method: 'sendDocument', field: 'document' } as const;
}

/** The smallest photo size is 160 px; this bounds a download that is anything else. */
const MAX_AVATAR_BYTES = 120_000;

// The Bot API is plain HTTP, so there is no client to adopt — but its method table is published
// as types. Parameters and results are read from it, which is what keeps the bodies below honest
// without putting a framework between the gateway and the network it already owns.
type Methods = ApiMethods<never>;
type Method = keyof Methods;
type Params<M extends Method> = Parameters<Methods[M]>[0];
type Result<M extends Method> = ReturnType<Methods[M]>;

export class TelegramChannel implements Channel {
  readonly type = 'telegram';
  readonly webhookHeader = 'x-telegram-bot-api-secret-token';
  readonly hidesAgentsFromEachOther = true;

  /** Per channel, when Telegram said it would accept requests again. Transport state only. */
  private readonly coolUntil = new Map<string, number>();

  constructor(private readonly clock: () => number = Date.now) {}

  receive(payload: unknown): IncomingMessage | null {
    const update = telegramUpdateSchema.parse(payload);

    const message = update.message;
    const file = message ? fileOf(message) : undefined;
    // A file without a caption is still a message: what it holds is what was said.
    const text = message?.text ?? message?.caption ?? file?.label;

    // A join notice or a sticker: nothing to answer, and not an error.
    if (!message?.from || !text?.trim()) {
      return null;
    }

    const name = message.from.first_name ?? message.from.username;
    const group = GROUP_CHATS.has(message.chat.type ?? '');

    return {
      actorId: String(message.from.id),
      chatId: String(message.chat.id),
      text,
      requestKey: String(update.update_id),
      ...(name ? { displayName: name } : {}),
      scope: group ? 'group' : 'direct',
      ...(group && message.chat.title ? { groupName: message.chat.title } : {}),
      // A mention of an account without a username carries its id; an `@username` carries only
      // the text, which is compared with the handle the bot was identified by.
      mentions: (message.entities ?? message.caption_entities ?? []).flatMap((entity) => {
        if (entity.user) {
          return [String(entity.user.id)];
        }

        if (entity.type === 'mention' && entity.offset !== undefined && entity.length) {
          return [text.slice(entity.offset, entity.offset + entity.length).toLowerCase()];
        }

        return [];
      }),
      ...(message.reply_to_message?.from
        ? { replyTo: String(message.reply_to_message.from.id) }
        : {}),
    };
  }

  async download(
    payload: unknown,
    context: DeliveryContext,
  ): Promise<{ media?: InlineMedia[]; note?: string }> {
    const message = telegramUpdateSchema.parse(payload).message;
    const file = message ? fileOf(message) : undefined;
    const token = context.credential;

    if (!file || !token || !BOT_TOKEN.test(token)) {
      return {};
    }

    const failed = {
      note: '[The attachment could not be downloaded or exceeds 16 MB. Ask the sender to send it again in a smaller file.]',
    };

    if ((file.file_size ?? 0) > MAX_MEDIA_BYTES) {
      return failed;
    }

    const options = { fetch: context.fetch, signal: context.signal };
    const found = await this.request('getFile', token, { file_id: file.file_id }, options);
    const path = found?.ok ? found.result.file_path : undefined;

    if (!path) {
      return failed;
    }

    try {
      const response = await context.fetch(`https://api.telegram.org/file/bot${token}/${path}`, {
        signal: AbortSignal.any([context.signal, AbortSignal.timeout(FILE_TIMEOUT_MS)]),
      });

      if (!response.ok) {
        return failed;
      }

      const bytes = await readMediaBody(response, MAX_MEDIA_BYTES);

      return {
        media: [
          {
            mimeType: file.mimeType,
            data: bytes.toString('base64'),
            ...('voice' in file ? { voice: true } : {}),
            ...('name' in file && file.name ? { name: file.name } : {}),
          },
        ],
      };
    } catch {
      // The URL holds the bot token; nothing about the failure is repeated.
      return failed;
    }
  }

  /**
   * False while Telegram is still refusing this bot for flood control. The dispatcher reads it
   * before claiming anything, so a rate-limited answer waits in the queue instead of burning
   * its one attempt against a closed door.
   */
  async canSend(channelId: string): Promise<boolean> {
    return (this.coolUntil.get(channelId) ?? 0) <= this.clock();
  }

  /**
   * One call to the Bot API. Returns undefined when the request itself did not complete, which
   * is not the same as Telegram refusing it, and never lets the URL reach a log: the bot
   * credential lives in the path.
   */
  private async request<M extends Method>(
    method: M,
    token: string,
    params: Params<M>,
    options: {
      fetch: typeof globalThis.fetch;
      signal: AbortSignal;
      timeout?: number;
      channelId?: string;
    },
  ): Promise<ApiResponse<Result<M>> | undefined> {
    try {
      const response = await options.fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.any([
          options.signal,
          AbortSignal.timeout(options.timeout ?? REQUEST_TIMEOUT_MS),
        ]),
        body: JSON.stringify(params ?? {}),
      });

      const body = (await response.json()) as ApiResponse<Result<M>>;

      if (!body.ok && body.error_code === 429 && options.channelId) {
        const wait = (body.parameters?.retry_after ?? 0) * 1000 || DEFAULT_COOLDOWN_MS;

        this.coolUntil.set(options.channelId, this.clock() + Math.min(wait, MAX_COOLDOWN_MS));
      }

      return body;
    } catch {
      return undefined;
    }
  }

  /**
   * The bot's own numeric id, which is how its messages are recognised in a group, and its
   * `@username`, which is how people mention it there.
   */
  async identify(
    credential: string,
    fetch: typeof globalThis.fetch,
    signal: AbortSignal,
  ): Promise<{ address: string; handle?: string } | undefined> {
    if (!BOT_TOKEN.test(credential)) {
      return undefined;
    }

    const body = await this.request('getMe', credential, undefined, { fetch, signal });

    if (!body?.ok) {
      return undefined;
    }

    const { id, username } = body.result;

    return { address: String(id), ...(username ? { handle: `@${username.toLowerCase()}` } : {}) };
  }

  /** Replaces whatever webhook the bot had, so the last connection is the one Telegram calls. */
  async register(
    credential: string,
    webhook: { channelId: string; origin: string; secret: string },
    fetch: typeof globalThis.fetch,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (!BOT_TOKEN.test(credential)) {
      return false;
    }

    const body = await this.request(
      'setWebhook',
      credential,
      {
        url: `${webhook.origin}/v1/telegram/${webhook.channelId}`,
        secret_token: webhook.secret,
        allowed_updates: ['message'],
      },
      { fetch, signal },
    );

    return body?.ok === true;
  }

  /**
   * A person's newest profile photo, or a group's photo, in its smallest size. Three calls: find
   * the file, ask where it is, download it — each bounded, and any failure is just no picture.
   */
  async avatar(
    target: { chatId: string; actorId: string; scope: 'direct' | 'group' },
    context: DeliveryContext,
  ): Promise<InlineMedia | undefined> {
    const token = context.credential;

    if (!token || !BOT_TOKEN.test(token)) {
      return undefined;
    }

    const options = { fetch: context.fetch, signal: context.signal };
    let fileId: string | undefined;

    if (target.scope === 'group') {
      const chat = await this.request('getChat', token, { chat_id: target.chatId }, options);

      fileId = chat?.ok ? chat.result.photo?.small_file_id : undefined;
    } else {
      const photos = await this.request(
        'getUserProfilePhotos',
        token,
        { user_id: Number(target.actorId), limit: 1 },
        options,
      );

      fileId = photos?.ok ? photos.result.photos[0]?.[0]?.file_id : undefined;
    }

    if (!fileId) {
      return undefined;
    }

    const file = await this.request('getFile', token, { file_id: fileId }, options);
    const path = file?.ok ? file.result.file_path : undefined;

    if (!path) {
      return undefined;
    }

    try {
      const response = await context.fetch(`https://api.telegram.org/file/bot${token}/${path}`, {
        signal: AbortSignal.any([context.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      });
      const bytes = await readMediaBody(response, MAX_AVATAR_BYTES);

      return response.ok ? { mimeType: 'image/jpeg', data: bytes.toString('base64') } : undefined;
    } catch {
      // The URL holds the bot token; nothing about the failure is repeated.
      return undefined;
    }
  }

  /** Telegram clears this when a message lands, so it is re-armed on every dispatch tick. */
  async typing(chatId: string, context: DeliveryContext): Promise<void> {
    const token = context.credential;

    if (!token || !BOT_TOKEN.test(token)) {
      return;
    }

    // An indicator nobody saw is not worth a failed delivery, so the answer is not read.
    await this.request(
      'sendChatAction',
      token,
      { chat_id: chatId, action: 'typing' },
      {
        fetch: context.fetch,
        signal: context.signal,
        // Short on purpose: a slow tick must not delay the answer it is announcing.
        timeout: TYPING_TIMEOUT_MS,
        channelId: context.channelId,
      },
    );
  }

  async send(message: OutgoingMessage, context: DeliveryContext): Promise<DeliveryOutcome> {
    const token = context.credential;
    const remoteMessageIds: number[] = [];

    if (!token || !BOT_TOKEN.test(token)) {
      return { status: 'failed', remoteMessageIds };
    }

    if (message.media) {
      const { method, field } = sendMethodOf(message.media);
      const form = new FormData();
      form.set('chat_id', message.chatId);
      if (message.text) form.set('caption', message.text.slice(0, 1024));
      form.set(
        field,
        new Blob([new Uint8Array(Buffer.from(message.media.data, 'base64'))], {
          type: message.media.mimeType,
        }),
        fileNameOf(message.media.mimeType, message.media.name),
      );
      if ((this.coolUntil.get(context.channelId) ?? 0) > this.clock())
        return { status: 'pending', remoteMessageIds };
      try {
        const response = await context.fetch(`https://api.telegram.org/bot${token}/${method}`, {
          method: 'POST',
          body: form,
          signal: AbortSignal.any([context.signal, AbortSignal.timeout(30_000)]),
        });
        const body = z
          .object({
            ok: z.boolean(),
            result: z.object({ message_id: z.number() }).optional(),
            error_code: z.number().optional(),
          })
          .parse(JSON.parse((await readMediaBody(response, 100_000)).toString()));
        if (body.ok && body.result)
          return { status: 'sent', remoteMessageIds: [body.result.message_id] };
        if (body.error_code === 429) {
          this.coolUntil.set(context.channelId, this.clock() + DEFAULT_COOLDOWN_MS);
          return { status: 'pending', remoteMessageIds };
        }
        return { status: 'failed', remoteMessageIds };
      } catch {
        return { status: 'unknown', remoteMessageIds };
      }
    }

    for (let offset = 0; offset < message.text.length; offset += MESSAGE_CHUNK_SIZE) {
      const body = await this.request(
        'sendMessage',
        token,
        {
          chat_id: message.chatId,
          text: message.text.slice(offset, offset + MESSAGE_CHUNK_SIZE),
        },
        { fetch: context.fetch, signal: context.signal, channelId: context.channelId },
      );

      if (body?.ok) {
        remoteMessageIds.push(body.result.message_id);
        continue;
      }

      // Flood control is the one refusal that says the message was not delivered and asks to
      // be repeated. With nothing sent yet there is nothing to duplicate, so it goes back in
      // the queue; once a chunk has landed, replaying the whole answer would repeat it.
      if (refused(body) && remoteMessageIds.length === 0) {
        return { status: 'pending', remoteMessageIds };
      }

      // A lost response does not prove the message was absent. Preserve confirmed chunks.
      return { status: 'unknown', remoteMessageIds };
    }

    return { status: 'sent', remoteMessageIds };
  }
}

/** Refused for flood control: not delivered, and Telegram asked for it to be repeated. */
function refused(body: ApiResponse<unknown> | undefined): boolean {
  return body !== undefined && !body.ok && body.error_code === 429;
}
