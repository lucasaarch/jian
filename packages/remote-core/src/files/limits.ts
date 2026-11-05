/**
 * The contract's constants, copied. The published worker is one bundle that old workers accept as
 * their update only under 1,000,000 characters, and importing the Zod schemas puts Zod in it.
 * tests/files.test.ts compares every value here with packages/contracts so they cannot drift.
 */
export const FILES_CAPABILITY = 'files-v1';
export const MAX_TEXT = 400_000;
export const RESULT_BYTES = 480_000;
export const MAX_FIND_CHARS = 200_000;
export const MAX_SEARCH_CHARS = 60_000;
export const MAX_READ_BYTES = 20 * 1024 * 1024;
export const MAX_GIT_BYTES = 500_000;
