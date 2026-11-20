/**
 * Shorter than this, an encoded piece of a secret would match ordinary output: the values
 * themselves are at least 8 characters (the value rules in `packages/contracts/src/secrets.ts`).
 */
const SHORTEST = 8;

/**
 * Every form of a Secret's sensitive value that output is masked for: the value as typed,
 * URL-encoded (a query string, a form body), and base64 and base64url, the way an
 * `Authorization: Basic` header or a debug dump carries it.
 *
 * Base64 of a value inside a longer text depends on where the value starts in it, by its offset
 * modulo three, and the characters at either edge also hold bits of the bytes around it. So each
 * of the three offsets gives the run of characters made of the value's bits alone: whatever
 * surrounds it, one of them is in the encoded text. At most the two or three characters at its
 * edges are left showing, a few bits each.
 */
export function secretForms(value: string): string[] {
  const bytes = Buffer.from(value, 'utf8');
  const forms = new Set([
    value,
    encodeURIComponent(value),
    new URLSearchParams({ v: value }).toString().slice(2),
  ]);

  for (const offset of [0, 1, 2]) {
    const encoded = Buffer.concat([Buffer.alloc(offset), bytes])
      .toString('base64')
      .replace(/=+$/, '');
    // The characters that carry a bit of the padding in front: none, two, or three.
    const start = [0, 2, 3][offset] ?? 0;
    // A last group the value does not fill also holds a bit of whatever follows it.
    const end = (offset + bytes.length) % 3 === 0 ? encoded.length : encoded.length - 1;
    const core = encoded.slice(start, end);

    forms.add(core);
    forms.add(core.replaceAll('+', '-').replaceAll('/', '_'));
  }

  return [...forms].filter((form) => form.length >= SHORTEST);
}
