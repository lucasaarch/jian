import { sql } from 'drizzle-orm';
import type { Queryable } from '../storage/database.js';
import {
  add,
  at,
  channelKind,
  failureKind,
  num,
  PUBLIC_MODELS,
  rowsOf,
  runOrigin,
  tally,
} from './vocabulary.js';

type RunRow = {
  status: string;
  error: string | null;
  provider: string | null;
  model_id: string | null;
  effort: string | null;
  kind: string | null;
  input_tokens: unknown;
  cached_tokens: unknown;
  cache_write_tokens: unknown;
  output_tokens: unknown;
  steps: unknown;
  channel: string | null;
  on_machine: boolean;
  subagent: boolean;
  call: boolean;
  grouped: boolean;
  scheduled: boolean;
  decision: string | null;
  asked: boolean;
};

/**
 * The runs started between `since` and `until`, counted: how they ended, on what, from where,
 * and the approvals they asked for. One row per run, reading only the columns that hold a fixed
 * word or a number; the error is read to be put into a kind, and goes no further.
 */
export async function runUsage(db: Queryable, since: Date, until: Date) {
  const rows = await rowsOf<RunRow>(
    db,
    sql`
      select r.status, r.error,
        r.model->>'provider' as provider, r.model->>'modelId' as model_id,
        r.model->>'reasoningEffort' as effort, p.kind,
        r.usage->>'inputTokens' as input_tokens,
        r.usage->>'cachedInputTokens' as cached_tokens,
        r.usage->>'cacheWriteTokens' as cache_write_tokens,
        r.usage->>'outputTokens' as output_tokens,
        r.usage->>'steps' as steps,
        s.channel, s.remote_machine_id is not null as on_machine,
        r.subagent is not null as subagent, r.call is not null as call,
        r.group_turn is not null as grouped,
        exists (select 1 from schedule_runs sr where sr.run_id = r.id) as scheduled,
        r.approval is not null as asked, r.approval->>'decision' as decision
      from runs r
      join sessions s on s.id = r.session_id
      left join providers p on p.id::text = r.model->>'providerId'
      where r.created_at >= ${at(since)} and r.created_at < ${at(until)}
    `,
  );

  const statuses: Record<string, number> = {};
  const models: Record<string, number> = {};
  const efforts: Record<string, number> = {};
  const failures: Record<string, number> = {};
  const interruptions: Record<string, number> = {};
  const origins: Record<string, number> = {};
  const places = { gateway: 0, machine: 0 };
  const approvals = { asked: 0, approved: 0, rejected: 0, undecided: 0 };
  const tokens = { input: 0, cached: 0, cache_write: 0, output: 0 };
  let steps = 0;
  for (const run of rows) {
    add(statuses, run.status);
    if (run.provider) {
      const named = PUBLIC_MODELS.has(run.kind ?? run.provider) ? run.model_id : 'custom';
      add(models, `${run.provider}:${named ?? 'custom'}`);
    }
    if (run.effort) add(efforts, run.effort);
    if (run.status === 'failed') add(failures, failureKind(run.error));
    if (run.status === 'interrupted') add(interruptions, failureKind(run.error));
    add(
      origins,
      runOrigin({
        subagent: run.subagent,
        call: run.call,
        schedule: run.scheduled,
        group: run.grouped,
        channel: run.channel,
      }),
    );
    places[run.on_machine ? 'machine' : 'gateway']++;
    if (run.asked) {
      approvals.asked++;
      if (run.decision === 'approved') approvals.approved++;
      else if (run.decision === 'rejected') approvals.rejected++;
      else approvals.undecided++;
    }
    tokens.input += num(run.input_tokens);
    tokens.cached += num(run.cached_tokens);
    tokens.cache_write += num(run.cache_write_tokens);
    tokens.output += num(run.output_tokens);
    steps += num(run.steps);
  }

  return {
    runs: rows.length,
    run_statuses: statuses,
    steps,
    tokens,
    models,
    efforts,
    failures,
    interruptions,
    run_origins: origins,
    run_places: places,
    approvals,
    ...(await runShapes(db, since, until)),
    sessions_active: await activeSessions(db, since, until),
  };
}

/**
 * How long, how big and how many steps a run took, as percentiles, computed by the database.
 * A run has no start or end of its own: from its creation to its last change, which for a run
 * that completed is when it ended, queue time included. Seconds, rounded to one decimal.
 */
async function runShapes(db: Queryable, since: Date, until: Date) {
  const [row] = await rowsOf<Record<string, unknown>>(
    db,
    sql`
      with window_runs as (
        select status,
          extract(epoch from updated_at - created_at) as seconds,
          coalesce((usage->>'inputTokens')::bigint, 0)
            + coalesce((usage->>'outputTokens')::bigint, 0) as tokens,
          (usage->>'steps')::int as steps,
          usage is not null as measured
        from runs
        where created_at >= ${at(since)} and created_at < ${at(until)}
      )
      select
        percentile_cont(0.5) within group (order by seconds)
          filter (where status = 'completed') as seconds_p50,
        percentile_cont(0.95) within group (order by seconds)
          filter (where status = 'completed') as seconds_p95,
        max(seconds) filter (where status = 'completed') as seconds_max,
        percentile_cont(0.5) within group (order by tokens) filter (where measured) as tokens_p50,
        percentile_cont(0.95) within group (order by tokens) filter (where measured) as tokens_p95,
        percentile_cont(0.5) within group (order by steps) filter (where measured) as steps_p50,
        percentile_cont(0.95) within group (order by steps) filter (where measured) as steps_p95
      from window_runs
    `,
  );
  const value = (key: string, places = 0) => {
    const factor = 10 ** places;
    return Math.round(num(row?.[key]) * factor) / factor;
  };
  return {
    run_seconds: {
      p50: value('seconds_p50', 1),
      p95: value('seconds_p95', 1),
      max: value('seconds_max', 1),
    },
    run_tokens: { p50: value('tokens_p50'), p95: value('tokens_p95') },
    run_steps: { p50: value('steps_p50', 1), p95: value('steps_p95', 1) },
  };
}

/** Conversations with a run in the window, by the kind of channel they are on. */
async function activeSessions(db: Queryable, since: Date, until: Date) {
  const rows = await rowsOf<{ key: string | null; n: unknown }>(
    db,
    sql`
      select s.channel as key, count(distinct r.session_id) as n
      from runs r join sessions s on s.id = r.session_id
      where r.created_at >= ${at(since)} and r.created_at < ${at(until)}
      group by s.channel
    `,
  );
  return tally(rows, channelKind);
}
