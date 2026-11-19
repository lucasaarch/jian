import { artifactFileFormats, MCP_APP_ADDRESSES, sessionArtifactTypeSchema } from '@jian/contracts';
import { sql } from 'drizzle-orm';
import { listMcpServers } from '../mcp/repository.js';
import { builtinSkillNames } from '../skills/builtin/index.js';
import type { Queryable } from '../storage/database.js';
import { add, appOfServer, at, isJianTool, num, rowsOf } from './vocabulary.js';

/**
 * How far before the window a run may have started and still write steps inside it, in ms. The
 * steps are found through their runs, by the index on the run, rather than by reading every
 * checkpoint the installation ever wrote; a turn longer than this is counted in no window.
 */
const LONGEST_RUN_MS = 24 * 60 * 60 * 1000;

/** The formats `send_artifact` takes. Its input is checked before the call, and read as any text. */
const FORMATS = new Set(sessionArtifactTypeSchema.options.flatMap(artifactFileFormats));

/** The apps a failed server is recorded as (`mcp-unavailable`): the known ones, AWS and GitHub. */
const APPS = new Set([...Object.keys(MCP_APP_ADDRESSES), 'aws', 'github']);

const PHASES = [
  'tool-started',
  'tool-failed',
  'context-compacted',
  'compaction-failed',
  'context-truncated',
  'model-reconnected',
  'mcp-unavailable',
];

type StepRow = {
  phase: string;
  tool: string | null;
  server: string | null;
  format: string | null;
  skill: string | null;
  attempts: unknown;
  waited_ms: unknown;
  recovered: string | null;
  servers: Array<{ name?: unknown; app?: unknown }> | null;
};

/**
 * What the runs did, step by step, from their checkpoints: which tools, which failed, how the
 * context was kept, how often a provider made them wait. Only the fields that hold a fixed name
 * or a number are read out of each one; a tool's input is never loaded, except the one field of
 * two tools whose values are a fixed list (an Artifact's format, a skill's name).
 */
export async function stepUsage(db: Queryable, since: Date, until: Date) {
  const rows = await rowsOf<StepRow>(
    db,
    sql`
      select c.data->>'phase' as phase,
        c.data->>'toolName' as tool,
        c.data->'mcp'->>'server' as server,
        case when c.data->>'toolName' = 'send_artifact'
          then c.data->'input'->>'format' end as format,
        case when c.data->>'toolName' = 'load_skill'
          then c.data->'input'->>'name' end as skill,
        c.data->>'attempts' as attempts,
        c.data->>'waitedMs' as waited_ms,
        c.data->>'recovered' as recovered,
        case when c.data->>'phase' = 'mcp-unavailable' then c.data->'servers' end as servers
      from checkpoints c
      where c.run_id in (
          select id from runs
          where created_at >= ${at(new Date(since.getTime() - LONGEST_RUN_MS))}
            and created_at < ${at(until)}
        )
        and c.created_at >= ${at(since)} and c.created_at < ${at(until)}
        and c.data->>'phase' in (${sql.join(
          PHASES.map((phase) => sql`${phase}`),
          sql`, `,
        )})
    `,
  );

  const servers = await listMcpServers(db);
  const appOf = new Map(servers.map((server) => [server.name, appOfServer(server)]));
  // A server that is no longer listed: the GitHub integration's own (`github`, `github_<login>`)
  // is GitHub; any other is one the owner named.
  const appByName = (name: unknown) =>
    typeof name !== 'string'
      ? 'custom'
      : appOf.has(name)
        ? (appOf.get(name) ?? 'custom')
        : /^github(_|$)/.test(name)
          ? 'github'
          : 'custom';

  const tools: Record<string, number> = {};
  const toolFailures: Record<string, number> = {};
  const apps: Record<string, number> = {};
  const unavailable: Record<string, number> = {};
  const sent: Record<string, number> = {};
  const skills: Record<string, number> = {};
  const context = { compacted: 0, compaction_failed: 0, truncated: 0 };
  const reconnects = { calls: 0, attempts: 0, waited_seconds: 0, recovered: 0, gave_up: 0 };
  let waitedMs = 0;
  for (const step of rows) {
    if (step.phase === 'context-compacted') context.compacted++;
    else if (step.phase === 'compaction-failed') context.compaction_failed++;
    else if (step.phase === 'context-truncated') context.truncated++;
    else if (step.phase === 'model-reconnected') {
      reconnects.calls++;
      reconnects.attempts += num(step.attempts);
      waitedMs += num(step.waited_ms);
      if (step.recovered === 'true') reconnects.recovered++;
      else reconnects.gave_up++;
    } else if (step.phase === 'mcp-unavailable') {
      for (const server of Array.isArray(step.servers) ? step.servers : []) {
        // The app recorded when it failed, or the server's as it is listed now.
        add(
          unavailable,
          typeof server.app === 'string' && APPS.has(server.app)
            ? server.app
            : appByName(server.name),
        );
      }
    } else if (step.phase === 'tool-failed') {
      // A server's tool reaches the model as `<server>_<tool>_<hash>`: a name the owner chose.
      if (isJianTool(step.tool)) add(toolFailures, step.tool);
    } else if (step.server) add(apps, appByName(step.server));
    else if (isJianTool(step.tool)) {
      add(tools, step.tool);
      if (step.tool === 'send_artifact') {
        add(sent, step.format && FORMATS.has(step.format) ? step.format : 'other');
      }
      if (step.tool === 'load_skill') {
        // A built-in skill's name is the gateway's; any other is one the owner or an agent wrote.
        add(skills, step.skill && builtinSkillNames.has(step.skill) ? step.skill : 'custom');
      }
    }
  }
  reconnects.waited_seconds = Math.round(waitedMs / 1000);

  return {
    tools,
    tool_failures: toolFailures,
    mcp_app_calls: apps,
    mcp_unavailable: unavailable,
    artifacts_sent: sent,
    skills_loaded: skills,
    context,
    model_reconnects: reconnects,
  };
}
