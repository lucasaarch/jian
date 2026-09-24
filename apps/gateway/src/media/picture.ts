import type { InlineMedia } from '@jian/contracts';
import sharp from 'sharp';

/** A profile's picture, stored as a data URL, as the bytes a channel uploads. */
export function pictureOf(avatar: string): InlineMedia {
  const match = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(avatar);

  if (!match?.[1] || !match[2]) throw new Error('The profile picture is not an inline image');

  return { mimeType: match[1] as InlineMedia['mimeType'], data: match[2] };
}

/** A square 640 px JPEG: what both chat protocols take for a profile photo. */
export async function asJpeg(picture: InlineMedia): Promise<Buffer> {
  const bytes = Buffer.from(picture.data, 'base64');

  return sharp(bytes).resize(640, 640, { fit: 'cover' }).jpeg({ quality: 90 }).toBuffer();
}
