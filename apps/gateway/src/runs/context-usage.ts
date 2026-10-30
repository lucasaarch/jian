import type { ContextPolicy, ModelConfig, SessionContext } from '@jian/contracts';
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import { COMPACT_AT } from '../context/compaction.js';
import type { Queryable } from '../storage/database.js';
import { checkpoints, runs } from '../storage/schema.js';

const count = (value: unknown) => Math.max(0, Math.round(Number(value ?? 0)) || 0);

/**
 * How full a conversation's context is, read from what the runtime already records: each step's
 * checkpoint holds the input its call took, and each compaction what it came to. The room is the
 * last run's own policy, derived from its model; before any run, the agent's.
 */
export async function sessionContext(
  db: Queryable,
  profileId: string,
  sessionId: string,
  agent: { policy: ContextPolicy; model: Pick<ModelConfig, 'provider' | 'modelId'> },
): Promise<SessionContext> {
  const here = and(eq(runs.profileId, profileId), eq(runs.sessionId, sessionId));
  const [totals] = await db
    .select({
      input: sql<string>`coalesce(sum((${runs.usage}->>'inputTokens')::numeric), 0)`,
      cached: sql<string>`coalesce(sum((${runs.usage}->>'cachedInputTokens')::numeric), 0)`,
      output: sql<string>`coalesce(sum((${runs.usage}->>'outputTokens')::numeric), 0)`,
      turns: sql<string>`count(*)`,
    })
    .from(runs)
    .where(and(here, isNotNull(runs.usage)));

  const latest = (phase: string) =>
    db
      .select({
        at: checkpoints.createdAt,
        data: checkpoints.data,
        policy: runs.contextPolicy,
        model: runs.model,
      })
      .from(checkpoints)
      .innerJoin(runs, eq(runs.id, checkpoints.runId))
      .where(
        and(
          here,
          eq(checkpoints.profileId, profileId),
          sql`${checkpoints.data}->>'phase' = ${phase}`,
        ),
      )
      .orderBy(desc(checkpoints.createdAt))
      .limit(1);
  const [[step], [compaction]] = await Promise.all([
    latest('step-completed'),
    latest('context-compacted'),
  ]);

  const policy = step?.policy ?? agent.policy;
  const model = step?.model ?? agent.model;
  const limit = Math.max(1, policy.inputTokens - policy.outputTokens);
  const usage = (step?.data as { usage?: { inputTokens?: unknown } } | undefined)?.usage;
  const prompt = (step?.data as { prompt?: { estimatedTokens?: unknown } } | undefined)?.prompt;
  const compactedData = compaction?.data as
    | { beforeTokens?: unknown; afterTokens?: unknown }
    | undefined;
  // A compaction after the last call is the size the next call starts from.
  const compactedLast = compaction && (!step || compaction.at > step.at);

  return {
    used: compactedLast
      ? count(compactedData?.afterTokens)
      : step
        ? count(usage?.inputTokens ?? prompt?.estimatedTokens)
        : null,
    limit,
    window: policy.inputTokens,
    compactAt: Math.round(limit * COMPACT_AT),
    measuredAt: (compactedLast ? compaction.at : step?.at)?.toISOString() ?? null,
    model: { provider: model.provider, modelId: model.modelId },
    totals: {
      inputTokens: count(totals?.input),
      cachedInputTokens: count(totals?.cached),
      outputTokens: count(totals?.output),
      turns: count(totals?.turns),
    },
    compacted: compaction
      ? {
          at: compaction.at.toISOString(),
          beforeTokens: count(compactedData?.beforeTokens),
          afterTokens: count(compactedData?.afterTokens),
        }
      : null,
  };
}
