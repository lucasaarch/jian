import { createHash } from 'node:crypto';

/**
 * A UUID derived from what it identifies, so writing the same thing twice lands on the same
 * row. It carries version 8 and the RFC 9562 variant: a bare slice of a hash is not a UUID the
 * contracts accept, and a record stored under one fails every read that validates it.
 */
export function stableUuid(source: string): string {
  const bytes = createHash('sha256').update(source).digest().subarray(0, 16);

  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;

  return bytes.toString('hex').replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
}
