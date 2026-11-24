/**
 * The contract's constants, copied for the same reason as files/limits.ts: the published worker
 * stays one small bundle without Zod. tests/forwards.test.ts compares each value with
 * packages/contracts so they cannot drift.
 */
export const FORWARDS_CAPABILITY = 'forwards-v1';
/** A worker listens on 127.0.0.1 in this range, first and last. */
export const LOCAL_PORTS = { first: 41000, last: 41999 } as const;
/** The most bytes one upload carries. */
export const CHUNK_MAX = 1024 * 1024;
