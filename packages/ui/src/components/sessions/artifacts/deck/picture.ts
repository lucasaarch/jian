import { SLIDE_HEIGHT, SLIDE_WIDTH } from '@jian/contracts';

/**
 * A picture the owner picked, made ready to be written into a slide: the frame a slide is edited
 * and shown in loads nothing, so a picture lives in the slide's own markup as a `data:` URL.
 *
 * A slide is at most `SESSION_ARTIFACT_MAX` characters, so the picture is redrawn no larger than
 * the canvas needs (twice its size, for a sharp screen), as WebP where the browser writes it and
 * as JPEG or PNG where not, and smaller again until it fits in `room`, what the slide has left.
 * An SVG is kept as it is: it is text, and drawn as a picture it runs nothing.
 */
export type Picture = { image: string; width: number; height: number };

/** How much larger than the canvas a picture is kept, for a sharp screen. */
const SHARP = 2;

const asDataUrl = (file: Blob) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('The picture could not be read.'));
    reader.readAsDataURL(file);
  });

const loaded = (source: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('This file is not a picture the browser can show.'));
    image.src = source;
  });

/** The picture as a `data:` URL that fits in `room` characters, or why it cannot. */
export async function pictureFor(file: File, room: number): Promise<Picture> {
  if (!file.type.startsWith('image/')) throw new Error('Pick a picture: PNG, JPEG, WebP or SVG.');
  const original = await asDataUrl(file);
  const image = await loaded(original);
  const width = image.naturalWidth || SLIDE_WIDTH;
  const height = image.naturalHeight || SLIDE_HEIGHT;

  if (file.type === 'image/svg+xml') {
    if (original.length > room)
      throw new Error('This SVG is too large for what this slide has room for.');
    return { image: original, width, height };
  }
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (!context) throw new Error('The picture could not be prepared.');
  let fit = Math.min(1, (SLIDE_WIDTH * SHARP) / width, (SLIDE_HEIGHT * SHARP) / height);
  // A photo keeps nothing see-through, so JPEG suits it where WebP is not written.
  const fallback = file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';

  for (let tries = 0; tries < 6; tries += 1) {
    canvas.width = Math.max(1, Math.round(width * fit));
    canvas.height = Math.max(1, Math.round(height * fit));
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    let drawn = canvas.toDataURL('image/webp', 0.85);
    // A browser that cannot write WebP answers PNG instead.
    if (!drawn.startsWith('data:image/webp')) drawn = canvas.toDataURL(fallback, 0.85);
    if (drawn.length <= room) return { image: drawn, width: canvas.width, height: canvas.height };
    fit *= 0.7;
  }
  throw new Error('This picture is too large for what this slide has room for, even made smaller.');
}
