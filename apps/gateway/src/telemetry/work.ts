import { sessionArtifactTypeSchema } from '@jian/contracts';
import { sql } from 'drizzle-orm';
import type { Queryable } from '../storage/database.js';
import { at, channelKind, num, rowsOf, tally } from './vocabulary.js';

type Counted = { key: string | null; n: unknown };

const TYPES = new Set<string>(sessionArtifactTypeSchema.options);
const artifactType = (type: string | null) => (type && TYPES.has(type) ? type : 'other');

/**
 * What the agents made and exchanged between `since` and `until`, counted: Artifacts, messages,
 * memories, schedules, pull requests, email. Tables keyed by profile are read through it
 * (`profile_id in profiles`), so the window is found on their `(profile_id, created_at)` index.
 */
export async function workUsage(db: Queryable, since: Date, until: Date) {
  const inWindow = (column: string) =>
    sql`${sql.raw(column)} >= ${at(since)} and ${sql.raw(column)} < ${at(until)}`;

  const artifactsCreated = await rowsOf<Counted>(
    db,
    sql`select type as key, count(*) as n from session_artifacts
        where ${inWindow('created_at')} group by type`,
  );
  // Version 1 is the Artifact's creation; every later one is a change, by the agent or by hand.
  const artifactUpdates = await rowsOf<Counted>(
    db,
    sql`select author as key, count(*) as n from session_artifact_versions
        where version > 1 and ${inWindow('created_at')} group by author`,
  );
  const messages = await rowsOf<Counted & { direction: string }>(
    db,
    sql`
      select s.channel as key,
        case when m.role = 'assistant' then 'out' else 'in' end as direction,
        count(*) as n
      from messages m join sessions s on s.id = m.session_id
      where m.profile_id in (select id from profiles) and ${inWindow('m.created_at')}
        -- From a person only: not what another agent asked, nor what the gateway wrote to
        -- resume or compact a conversation.
        and (m.role = 'assistant' or (m.call is null and m.purpose is null))
      group by s.channel, direction
    `,
  );
  const [memories] = await rowsOf<{ written: unknown; created: unknown }>(
    db,
    sql`
      select count(*) as written, count(*) filter (where version = 1) as created
      from memories
      where profile_id in (select id from profiles) and ${inWindow('updated_at')}
    `,
  );
  const [schedules] = await rowsOf<{ started: unknown; failed: unknown; manual: unknown }>(
    db,
    sql`
      select count(*) filter (where sr.run_id is not null) as started,
        count(*) filter (where sr.error is not null or r.status = 'failed') as failed,
        count(*) filter (where sr.manual) as manual
      from schedule_runs sr left join runs r on r.id = sr.run_id
      where ${inWindow('sr.created_at')}
    `,
  );
  const [pulls] = await rowsOf<{ n: unknown }>(
    db,
    sql`select count(*) as n from pull_watchers where ${inWindow('created_at')}`,
  );
  const email = await rowsOf<Counted>(
    db,
    sql`select direction as key, count(*) as n from email_log
        where profile_id in (select id from profiles) and ${inWindow('created_at')}
        group by direction`,
  );

  const sent = tally(email);
  return {
    artifacts_created: tally(artifactsCreated, artifactType),
    artifact_updates: tally(artifactUpdates, (author) => (author === 'owner' ? 'owner' : 'agent')),
    messages_in: tally(
      messages.filter((row) => row.direction === 'in'),
      channelKind,
    ),
    messages_out: tally(
      messages.filter((row) => row.direction === 'out'),
      channelKind,
    ),
    memories_written: num(memories?.written),
    memories_created: num(memories?.created),
    schedule_runs: {
      started: num(schedules?.started),
      failed: num(schedules?.failed),
      manual: num(schedules?.manual),
    },
    pull_requests_opened: num(pulls?.n),
    email: { received: sent.received ?? 0, sent: sent.sent ?? 0 },
  };
}
