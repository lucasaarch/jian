import { protectionModeSchema, sessionArtifactTypeSchema } from '@jian/contracts';
import { count, eq, sql } from 'drizzle-orm';
import { listMcpServers } from '../mcp/repository.js';
import type { Queryable } from '../storage/database.js';
import {
  channels,
  githubInstallations,
  profiles,
  providers,
  remoteMachines,
  schedules,
  xAccounts,
} from '../storage/schema.js';
import { runUsage } from './runs.js';
import { stepUsage } from './steps.js';
import { add, appOfServer, num, rowsOf, tally } from './vocabulary.js';
import { workUsage } from './work.js';

const TYPES = new Set<string>(sessionArtifactTypeSchema.options);
const MODES = new Set<string>(protectionModeSchema.options);

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
  for (const server of servers) {
    const app = appOfServer(server);
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
    ...(await holdings(db)),
  };
}

/** What the installation keeps now, counted: Artifacts, skills, memories, devices and the like. */
async function holdings(db: Queryable) {
  const [row] = await rowsOf<Record<string, unknown>>(
    db,
    sql`
      select
        (select count(*) from session_artifacts where visibility = 'public') as artifacts_public,
        (select count(*) from artifact_folders) as artifact_folders,
        (select count(*) from projects) as projects,
        (select count(*) from session_worktrees where removed_at is null) as worktrees_active,
        (select count(*) from memories
          where expires_at is null or expires_at > now()) as memories,
        (select count(*) from skills
          where written_by is null and origin is null) as skills_owner,
        (select count(*) from skills where written_by = 'agent') as skills_agent,
        (select count(*) from skills
          where written_by is null and origin is not null) as skills_imported,
        (select count(*) from devices where revoked_at is null) as devices,
        (select count(*) from push_subscriptions) as push_subscriptions,
        (select count(*) from email_domains) as email_domains
    `,
  );
  const artifacts = await rowsOf<{ key: string | null; n: unknown }>(
    db,
    sql`select type as key, count(*) as n from session_artifacts group by type`,
  );
  // The owner's own conversations: the gateway's internal ones (a look back, a task) ask nothing.
  const protection = await rowsOf<{ key: string | null; n: unknown }>(
    db,
    sql`select protection as key, count(*) as n from sessions
        where channel not in ('learning', 'task') group by protection`,
  );
  return {
    artifacts: tally(artifacts, (type) => (type && TYPES.has(type) ? type : 'other')),
    artifacts_public: num(row?.artifacts_public),
    artifact_folders: num(row?.artifact_folders),
    projects: num(row?.projects),
    worktrees_active: num(row?.worktrees_active),
    memories: num(row?.memories),
    skills: {
      owner: num(row?.skills_owner),
      agent: num(row?.skills_agent),
      imported: num(row?.skills_imported),
    },
    sessions_by_protection: tally(protection, (mode) => (mode && MODES.has(mode) ? mode : 'other')),
    devices: num(row?.devices),
    push_subscriptions: num(row?.push_subscriptions),
    email_domains: num(row?.email_domains),
  };
}

/** What the installation did between `since` and `until`, counted. */
export async function usageBetween(db: Queryable, since: Date, until: Date) {
  return {
    ...(await runUsage(db, since, until)),
    ...(await stepUsage(db, since, until)),
    ...(await workUsage(db, since, until)),
  };
}
