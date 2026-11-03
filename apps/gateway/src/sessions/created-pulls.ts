import { sql } from 'drizzle-orm';
import { exposedEnding } from '../agent/mcp-names.js';
import type { Queryable } from '../storage/database.js';

/** GitHub's MCP tool that opens a pull request, as every name the model calls it by ends. */
const CREATE_ENDING = exposedEnding('create_pull_request');

/** Whether a tool the model called is GitHub's `create_pull_request`, on any MCP server. */
export const isPullCreation = (toolName: string) =>
  toolName.startsWith('mcp__') && toolName.endsWith(CREATE_ENDING);
/**
 * How much of each answer is read, in characters. GitHub's server answers with the new pull
 * request's address first; an older one sent the whole pull request, its page address deep in
 * it, where the API address at its head still names it.
 */
const ANSWER_CHARS = 20_000;
/** How many creations one read returns: more than a conversation has reason to open. */
const MOST = 500;

/**
 * What GitHub answered each pull request the agent created in this conversation with, the
 * latest first: by its own runs, and by those of the subagents it started, theirs included,
 * since the owner asked for that work here. A creation GitHub refused is left out.
 */
export async function listCreatedPullAnswers(
  db: Queryable,
  profileId: string,
  sessionId: string,
): Promise<string[]> {
  const result = await db.execute(sql`
    with recursive conversation(id) as (
      select id from runs where profile_id = ${profileId} and session_id = ${sessionId}
      union
      select child.id from runs child
      join conversation on child.subagent->>'parentRunId' = conversation.id::text
      where child.profile_id = ${profileId}
    )
    select left((call->'result')::text, ${ANSWER_CHARS}) as answer
    from checkpoints
    cross join lateral jsonb_array_elements(
      -- A step records every call it made; an action approved before its step, only itself.
      case
        when checkpoints.data->>'phase' = 'step-completed'
          and jsonb_typeof(checkpoints.data->'tools') = 'array'
          then checkpoints.data->'tools'
        when checkpoints.data->>'phase' = 'tool-completed'
          then jsonb_build_array(checkpoints.data)
        else '[]'::jsonb
      end
    ) with ordinality as calls(call, place)
    where checkpoints.profile_id = ${profileId}
      and checkpoints.run_id in (select id from conversation)
      and checkpoints.data->>'phase' in ('step-completed', 'tool-completed')
      and left(call->>'toolName', 5) = 'mcp__'
      and right(call->>'toolName', ${CREATE_ENDING.length}) = ${CREATE_ENDING}
      and coalesce(call->'result'->>'isError', 'false') <> 'true'
    order by checkpoints.created_at desc, checkpoints.id desc, calls.place desc
    limit ${MOST}
  `);
  // Both drivers, node-postgres and PGlite, answer a raw query with its rows under `rows`.
  const { rows } = result as unknown as { rows: { answer: string }[] };

  return rows.map((row) => row.answer);
}
