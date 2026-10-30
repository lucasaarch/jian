import type { GatewayApi, Mutation } from '../lib/api';

/**
 * What a section is handed: the ways to act. What it shows it reads itself, from the open
 * agent's queries, so a test or a story injects actions here and seeds data in the cache.
 */
export type SectionActions = {
  api: GatewayApi;
  /** Runs an action, shows its outcome and reloads what it changed. False means it failed. */
  mutate: Mutation;
  /** True while an action runs; a section disables its controls instead of queueing a second. */
  busy: boolean;
};
