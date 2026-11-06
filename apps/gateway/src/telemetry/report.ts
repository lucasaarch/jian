import { mcpAppOf } from '@jian/contracts';
import { and, count, eq, gte, lt, sql } from 'drizzle-orm';
import { listMcpServers } from '../mcp/repository.js';
import type { Queryable } from '../storage/database.js';
import {
  channels,
  checkpoints,
  githubInstallations,
  profiles,
  providers,
  remoteMachines,
  runs,
  schedules,
  xAccounts,
} from '../storage/schema.js';

/**
 * Providers whose model ids are a public catalog. Any other — a local server, an endpoint the
 * owner pointed somewhere — may carry a name they made up, so it is reported as `custom`.
 */
const PUBLIC_MODELS = new Set([
  'openai',
  'anthropic',
  'google',
  'openrouter',
  'openai-codex',
  'xai',
  'groq',
]);

/**
 * Why a run failed, as a kind. The message itself can quote what the agent was working on, so it
 * never leaves; only which of these it reads as.
 */
const FAILURES: Array<[string, RegExp]> = [
  ['context-budget', /context budget exceeded|run token budget/i],
  ['rate-limit', /\b429\b|rate.?limit|quota|usage limit/i],
  ['provider-auth', /\b401\b|\b403\b|unauthori[sz]ed|invalid.*(key|token)|credential/i],
  ['provider-refused', /provider refused|\b400\b|invalid request/i],
  ['provider-unavailable', /\b5\d\d\b|overloaded|unavailable|ECONN|ETIMEDOUT|fetch failed/i],
  ['timeout', /timed? ?out|stalled/i],
  ['tool-uncertain', /external tool outcome is uncertain/i],
];

/** How a connected server's tool is named for the model: it ends in an 8-character hash. */
const EXPOSED = /_[0-9a-f]{8}$/;

export const failureKind = (error: string | null | undefined) =>
  FAILURES.find(([, pattern]) => pattern.test(error ?? ''))?.[0] ?? 'other';

const add = (into: Record<string, number>, key: string, by = 1) => {
  into[key] = (into[key] ?? 0) + by;
};

/** What the installation is: how big, on what, with what connected. No names, no addresses. */
export async function installationFacts(db: Queryable) {
  const total = async (
    table:
      | typeof profiles
      | typeof remoteMachines
      | typeof schedules
      | typeof githubInstallations
      | typeof xAccounts,
  ) => Number((await db.select({ n: count() }).from(table))[0]?.n ?? 0);
  const servers = await listMcpServers(db);
  const apps: Record<string, number> = {};
  let custom = 0;
  for (const { url } of servers) {
    const app = mcpAppOf(url ?? undefined);
    if (app) add(apps, app);
    else custom++;
  }
  const kinds = await db
    .select({ kind: providers.kind, n: count() })
    .from(providers)
    .groupBy(providers.kind);
  const channelKinds = await db
    .select({ type: channels.type, n: count() })
    .from(channels)
    .where(eq(channels.enabled, true))
    .groupBy(channels.type);

  return {
    agents: await total(profiles),
    machines: await total(remoteMachines),
    schedules: await total(schedules),
    github_accounts: await total(githubInstallations),
    x_accounts: await total(xAccounts),
    mcp_apps: apps,
    mcp_custom_servers: custom,
    providers: Object.fromEntries(kinds.map((row) => [row.kind, Number(row.n)])),
    channels: Object.fromEntries(channelKinds.map((row) => [row.type, Number(row.n)])),
  };
}

/** What the installation did between `since` and `until`, counted. */
export async function usageBetween(db: Queryable, since: Date, until: Date) {
  const window = and(gte(runs.createdAt, since), lt(runs.createdAt, until));
  const done = await db
    .select({
      status: runs.status,
      error: runs.error,
      model: runs.model,
      usage: runs.usage,
      kind: providers.kind,
    })
    .from(runs)
    .leftJoin(providers, sql`${providers.id}::text = ${runs.model}->>'providerId'`)
    .where(window);

  const statuses: Record<string, number> = {};
  const models: Record<string, number> = {};
  const efforts: Record<string, number> = {};
  const failures: Record<string, number> = {};
  const tokens = { input: 0, cached: 0, cache_write: 0, output: 0 };
  let steps = 0;
  for (const run of done) {
    add(statuses, run.status);
    const model = run.model as { provider?: string; modelId?: string; reasoningEffort?: string };
    if (model?.provider) {
      const named = PUBLIC_MODELS.has(run.kind ?? model.provider) ? model.modelId : 'custom';
      add(models, `${model.provider}:${named ?? 'custom'}`);
    }
    if (model?.reasoningEffort) add(efforts, model.reasoningEffort);
    if (run.status === 'failed') add(failures, failureKind(run.error));
    const usage = run.usage;
    if (usage) {
      tokens.input += usage.inputTokens;
      tokens.cached += usage.cachedInputTokens ?? 0;
      tokens.cache_write += usage.cacheWriteTokens ?? 0;
      tokens.output += usage.outputTokens;
      steps += usage.steps;
    }
  }

  const servers = await listMcpServers(db);
  const appOf = new Map(servers.map((server) => [server.name, mcpAppOf(server.url ?? undefined)]));
  const phases = await db
    .select({ data: checkpoints.data })
    .from(checkpoints)
    .where(
      and(
        gte(checkpoints.createdAt, since),
        lt(checkpoints.createdAt, until),
        sql`${checkpoints.data}->>'phase' in ('tool-started', 'context-compacted', 'compaction-failed', 'context-truncated')`,
      ),
    );
  const tools: Record<string, number> = {};
  const apps: Record<string, number> = {};
  const context = { compacted: 0, compaction_failed: 0, truncated: 0 };
  for (const { data } of phases) {
    const step = data as { phase: string; toolName?: string; mcp?: { server?: string } };
    if (step.phase === 'context-compacted') context.compacted++;
    else if (step.phase === 'compaction-failed') context.compaction_failed++;
    else if (step.phase === 'context-truncated') context.truncated++;
    else if (step.mcp?.server) add(apps, appOf.get(step.mcp.server) ?? 'custom');
    // Jian's own tools: a fixed set of names, nothing the owner typed. A server's tool reaches the
    // model as `<server>_<tool>_<hash>`, which would carry a name the owner chose: never counted.
    else if (step.toolName && !EXPOSED.test(step.toolName)) add(tools, step.toolName);
  }

  return {
    runs: done.length,
    run_statuses: statuses,
    steps,
    tokens,
    models,
    efforts,
    failures,
    tools,
    mcp_app_calls: apps,
    context,
  };
}
