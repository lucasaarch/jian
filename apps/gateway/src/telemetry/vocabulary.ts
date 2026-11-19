import {
  AGENT_SESSION_CHANNEL,
  GATEWAY_SESSION_CHANNEL,
  isAwsServer,
  LEARNING_SESSION_CHANNEL,
  type McpServer,
  mcpAppOf,
  TASK_SESSION_CHANNEL,
} from '@jian/contracts';
import { type SQL, sql } from 'drizzle-orm';
import type { Queryable } from '../storage/database.js';

/**
 * The fixed words a report is made of. Whatever reaches the destination is a count under one of
 * these, never a value read from a row as it was: a column the owner or a contact can write into
 * (a conversation's channel through the API, a server's name, an error) is first put into one of
 * these words, or `custom` / `other`.
 */

/**
 * Providers whose model ids are a public catalog. Any other — a local server, an endpoint the
 * owner pointed somewhere — may carry a name they made up, so it is reported as `custom`.
 */
export const PUBLIC_MODELS = new Set([
  'openai',
  'anthropic',
  'google',
  'openrouter',
  'openai-codex',
  'xai',
  'groq',
]);

/**
 * Why a run stopped, as a kind. The message itself can quote what the agent was working on, so
 * it never leaves; only which of these it reads as. The runtime's own messages come first, by
 * how they begin, since a provider's words quoted inside them could read as another kind.
 */
const FAILURES: Array<[string, RegExp]> = [
  ['tool-uncertain', /^External tool outcome is uncertain/i],
  ['stalled', /^Stopped: nothing came back from the model or a tool/],
  ['gateway-restarted', /^The agent stopped answering while it worked/],
  ['interrupted', /^Execution interrupted/],
  ['no-final-response', /^The provider ended the turn without a final response/],
  ['context-budget', /context budget exceeded|run token budget/i],
  // A provider closed for hours (`ModelWaitTooLong`): a subscription's window, not a rate limit
  // a turn waits out. Ahead of `rate-limit`, whose words it also carries.
  ['usage-limit', /^The provider takes no call until/],
  ['model-unknown', /^The provider does not know this model/],
  ['rate-limit', /^The provider refused with 429\b/],
  ['provider-auth', /^The provider refused with 40[13]\b/],
  ['model-unknown', /^The provider refused with 404\b/],
  ['provider-unavailable', /^The provider refused with 5\d\d\b/],
  ['provider-refused', /^The provider refused with \d{3}\b/],
  ['rate-limit', /\b429\b|rate.?limit|quota|usage limit/i],
  ['provider-auth', /\b401\b|\b403\b|unauthori[sz]ed|invalid.*(key|token)|credential/i],
  ['provider-refused', /provider refused|\b400\b|invalid request/i],
  ['provider-unavailable', /\b5\d\d\b|overloaded|unavailable|ECONN|ETIMEDOUT|fetch failed/i],
  ['timeout', /timed? ?out|stalled/i],
];

export const failureKind = (error: string | null | undefined) =>
  FAILURES.find(([, pattern]) => pattern.test(error ?? ''))?.[0] ?? 'other';

/**
 * A conversation's channel, as one of the kinds the gateway opens. The column is free text an
 * API caller can set (`sessionSchema`), so anything else is `other`.
 */
const CHANNELS: Record<string, string> = {
  [GATEWAY_SESSION_CHANNEL]: 'panel',
  api: 'api',
  telegram: 'telegram',
  whatsapp: 'whatsapp',
  // Retired in 0098; its conversations stay, and were WhatsApp.
  'whatsapp-business': 'whatsapp',
  email: 'email',
  [AGENT_SESSION_CHANNEL]: 'agent',
  [TASK_SESSION_CHANNEL]: 'task',
  [LEARNING_SESSION_CHANNEL]: 'learning',
};

export const channelKind = (channel: string | null | undefined) =>
  CHANNELS[channel ?? ''] ?? 'other';

/** Where a run came from: what started it, before the conversation it is in. */
export function runOrigin(run: {
  subagent: boolean;
  call: boolean;
  schedule: boolean;
  group: boolean;
  channel: string | null;
}): string {
  if (run.subagent) return 'subagent';
  if (run.call) return 'agent_call';
  if (run.schedule) return 'schedule';
  if (run.group) return 'group';
  const kind = channelKind(run.channel);
  if (kind === 'telegram' || kind === 'whatsapp' || kind === 'email') return 'channel';
  return kind;
}

/** How a connected server's tool is named for the model: it ends in an 8-character hash. */
export const EXPOSED = /_[0-9a-f]{8}$/;

/** Jian's own tool, by a name fixed in the gateway; a server's tool carries the server's name. */
export const isJianTool = (name: string | null | undefined): name is string =>
  Boolean(name) && !EXPOSED.test(name ?? '');

/** The app a server is, by its address, or AWS by its command; none for any other. */
export const appOfServer = (server: McpServer) =>
  isAwsServer(server) ? 'aws' : mcpAppOf(server.url ?? undefined);

export const add = (into: Record<string, number>, key: string, by = 1) => {
  into[key] = (into[key] ?? 0) + by;
};

/** Rows of a raw query; both drivers, node-postgres and PGlite, answer under `rows`. */
export async function rowsOf<T>(db: Queryable, query: SQL): Promise<T[]> {
  const result = await db.execute(query);
  return (result as unknown as { rows: T[] }).rows;
}

/** A moment as a query parameter: text cast by the database, the same on either driver. */
export const at = (moment: Date) => sql`${moment.toISOString()}::timestamptz`;

/** A number from a row: an aggregate comes back as text or bigint on one driver or the other. */
export const num = (value: unknown) => {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/** A count by key, from rows of `{ key, n }`, each key put through `word` first. */
export function tally(
  rows: Array<{ key: string | null; n: unknown }>,
  word: (key: string | null) => string = (key) => key ?? 'other',
): Record<string, number> {
  const into: Record<string, number> = {};
  for (const row of rows) add(into, word(row.key), num(row.n));
  return into;
}
