/** A response body went past what its caller is willing to hold in memory. */
export class BodyTooLarge extends Error {
  constructor(readonly limit: number) {
    super(`The response is larger than ${limit} bytes`);
    this.name = 'BodyTooLarge';
  }
}

/**
 * The body, read no further than `maxBytes`. `content-length` is only a shortcut: it can be absent
 * or false, and it counts compressed bytes, so what decides is what actually arrives. The rest of
 * the body is cancelled, which is what stops an endless one from costing any more.
 */
export async function readCapped(response: Response, maxBytes: number): Promise<Buffer> {
  if (Number(response.headers.get('content-length') ?? 0) > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new BodyTooLarge(maxBytes);
  }

  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);

  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, length);
      length += value.byteLength;
      if (length > maxBytes) throw new BodyTooLarge(maxBytes);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** As `response.text()`, which also drops a byte order mark, within `maxBytes`. */
export async function readCappedText(response: Response, maxBytes: number): Promise<string> {
  return new TextDecoder().decode(await readCapped(response, maxBytes));
}

/** As `response.json()`, within `maxBytes`. */
export async function readCappedJson(response: Response, maxBytes: number): Promise<unknown> {
  return JSON.parse(await readCappedText(response, maxBytes));
}
