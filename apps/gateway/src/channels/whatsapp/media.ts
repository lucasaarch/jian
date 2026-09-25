import { type InlineMedia, MAX_MEDIA_BYTES, mediaMimeOf } from '@jian/contracts';
import { downloadMediaMessage, normalizeMessageContent, type proto, type WAMessage } from 'baileys';

/**
 * A message as one line of text, for a quote or a reaction: its words, or what it was when it
 * had none, so "replying to a sticker" still says what was answered.
 */
export function describeWhatsApp(message: proto.IMessage | null | undefined): string | undefined {
  const content = normalizeMessageContent(message);
  const document =
    content?.documentMessage ?? content?.documentWithCaptionMessage?.message?.documentMessage;
  const words =
    content?.conversation ??
    content?.extendedTextMessage?.text ??
    content?.imageMessage?.caption ??
    content?.videoMessage?.caption ??
    document?.caption;

  if (words?.trim()) return words.trim().slice(0, 1000);
  if (content?.stickerMessage) return '[Sticker]';
  if (content?.imageMessage) return '[Photo]';
  if (content?.videoMessage) return '[Video]';
  if (content?.audioMessage) return content.audioMessage.ptt ? '[Voice message]' : '[Audio]';
  if (document) return document.fileName ? `[File: ${document.fileName}]` : '[File]';
  return undefined;
}

export async function readWhatsAppContent(
  message: WAMessage,
  download = downloadAttachment,
): Promise<{ text: string; media?: InlineMedia[] }> {
  const content = normalizeMessageContent(message.message);
  // A document sent with a caption arrives wrapped once more than one without.
  const document =
    content?.documentMessage ?? content?.documentWithCaptionMessage?.message?.documentMessage;
  const attachment =
    content?.imageMessage ??
    content?.audioMessage ??
    content?.videoMessage ??
    document ??
    content?.stickerMessage;
  const caption =
    content?.imageMessage?.caption ?? content?.videoMessage?.caption ?? document?.caption;
  const text = content?.conversation ?? content?.extendedTextMessage?.text ?? caption ?? '';
  if (!attachment) return { text };
  const name = document?.fileName?.trim().slice(0, 200) || undefined;
  try {
    if (Number(attachment.fileLength ?? 0) > MAX_MEDIA_BYTES) throw new Error('too large');
    const data = await download({ ...message, message: content });
    if (!data.length || data.length > MAX_MEDIA_BYTES) throw new Error('too large');
    return {
      text:
        text.trim() ||
        (content?.audioMessage?.ptt
          ? '[Voice message]'
          : content?.stickerMessage
            ? '[Sticker]'
            : name
              ? `[File: ${name}]`
              : '[Media attachment]'),
      media: [
        {
          mimeType: mediaMimeOf(attachment.mimetype, name),
          data: data.toString('base64'),
          ...(content?.audioMessage?.ptt ? { voice: true } : {}),
          ...(content?.stickerMessage ? { sticker: true } : {}),
          ...(name ? { name } : {}),
        },
      ],
    };
  } catch {
    return {
      text: `${text}\n[The attachment could not be downloaded or exceeds 16 MB. Ask the sender to send it again in a smaller file.]`.trim(),
    };
  }
}

async function downloadAttachment(message: WAMessage): Promise<Buffer> {
  const content = normalizeMessageContent(message.message);
  const item =
    content?.imageMessage ??
    content?.audioMessage ??
    content?.videoMessage ??
    content?.documentMessage ??
    content?.documentWithCaptionMessage?.message?.documentMessage ??
    content?.stickerMessage;
  if (item?.url) {
    const url = new URL(item.url);
    if (
      url.protocol !== 'https:' ||
      !url.hostname.endsWith('.whatsapp.net') ||
      url.username ||
      url.password ||
      (url.port && url.port !== '443')
    )
      throw new Error('Invalid WhatsApp media URL');
  }
  const stream = await downloadMediaMessage(message, 'stream', {
    options: { signal: AbortSignal.timeout(30_000) },
  });
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const part of stream) {
      const buffer = Buffer.from(part);
      bytes += buffer.length;
      if (bytes > MAX_MEDIA_BYTES) throw new Error('Attachment too large');
      chunks.push(buffer);
    }
  } finally {
    stream.destroy();
  }
  return Buffer.concat(chunks);
}
