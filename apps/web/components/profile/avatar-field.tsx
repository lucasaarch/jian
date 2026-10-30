'use client';

import { ImageUp, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../ui';

/** Square side in pixels. Large enough for the overview card on a retina screen. */
const SIZE = 256;
/** Mirrors avatarSchema in the contract: the encoded string must stay under this. */
const LIMIT = 100_000;
const QUALITIES = [0.82, 0.6, 0.4];

const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp'];

/**
 * Re-encodes in the browser so a phone photo never reaches the gateway: centre-cropped to a
 * square, downscaled, and written as JPEG at the first quality that fits the contract limit.
 * `from-image` applies the EXIF rotation, which a raw drawImage would ignore.
 */
async function encode(file: File) {
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

export function Avatar({
  name,
  avatar,
  className,
}: {
  name?: string;
  avatar?: string | null;
  className: string;
}) {
  return (
    <span className={className}>
      {avatar ? (
        // biome-ignore lint/performance/noImgElement: a data URL has nothing for next/image to optimize.
        <img src={avatar} alt="" />
      ) : (
        (name?.slice(0, 1).toLocaleUpperCase() ?? '+')
      )}
    </span>
  );
}

/**
 * Carries the picture as a hidden field so both profile forms keep reading plain FormData.
 * An empty value means "no picture": the caller sends null to clear it.
 */
export function AvatarField({
  name,
  profileName,
  current,
  onChange,
}: {
  name: string;
  profileName?: string;
  current?: string | null;
  /** The value lives in a hidden input, which fires no change of its own. */
  onChange?: () => void;
}) {
  const file = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(current ?? '');
  const [error, setError] = useState('');
  const initial = useRef(value);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the caller's handler is read, not tracked.
  useEffect(() => {
    if (value !== initial.current) {
      initial.current = value;
      onChange?.();
    }
  }, [value]);

  return (
    <div className="avatar-field">
      <input type="hidden" name={name} value={value} />
      <Avatar name={profileName} avatar={value || null} className="profile-avatar" />
      <div className="avatar-actions">
        <input
          ref={file}
          type="file"
          accept={ACCEPTED.join(',')}
          hidden
          onChange={async (event) => {
            const chosen = event.target.files?.[0];

            event.target.value = '';

            if (!chosen) {
              return;
            }

            setError('');

            if (!ACCEPTED.includes(chosen.type)) {
              setError('Choose a PNG, JPEG or WebP image.');

              return;
            }

            try {
              setValue(await encode(chosen));
            } catch (failure) {
              setError(failure instanceof Error ? failure.message : 'The image could not be read.');
            }
          }}
        />
        <Button variant="secondary" onClick={() => file.current?.click()}>
          <ImageUp size={16} />
          {value ? 'Change picture' : 'Choose a picture'}
        </Button>
        {value && (
          <Button variant="quiet" onClick={() => setValue('')}>
            <Trash2 size={16} />
            Remove
          </Button>
        )}
        <small>PNG, JPEG or WebP. Cropped square and scaled down to 256 px.</small>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
