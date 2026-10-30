/** Square side in pixels. Large enough for the overview card on a retina screen. */
const SIZE = 256;
/** Mirrors avatarSchema in the contract: the encoded string must stay under this. */
const LIMIT = 100_000;
const QUALITIES = [0.82, 0.6, 0.4];

/** What a picture may be chosen as; anything else is refused before it is read. */
export const AVATAR_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

/**
 * Re-encodes in the browser so a phone photo never reaches the gateway: centre-cropped to a
 * square, downscaled, and written as JPEG at the first quality that fits the contract limit.
 * `from-image` applies the EXIF rotation, which a raw drawImage would ignore.
 */
export async function encodeAvatar(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;

  const context = canvas.getContext('2d');

  if (!context) {
    bitmap.close();
    throw new Error('This browser could not process the image.');
  }

  context.drawImage(
    bitmap,
    (bitmap.width - side) / 2,
    (bitmap.height - side) / 2,
    side,
    side,
    0,
    0,
    SIZE,
    SIZE,
  );
  bitmap.close();

  for (const quality of QUALITIES) {
    const encoded = canvas.toDataURL('image/jpeg', quality);

    if (encoded.length <= LIMIT) {
      return encoded;
    }
  }

  throw new Error('This image could not be made small enough. Try another one.');
}
