import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Queryable } from '../storage/database.js';
import { teamMembers } from '../storage/schema.js';

/** Serializes membership changes with cross-profile run admission and execution checks. */
export async function lockTeamMembership(tx: Queryable): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(4021959222::bigint)`);
}

export async function shareTeam(
  tx: Queryable,
  profileA: string,
  profileB: string,
): Promise<boolean> {
  const memberTeams = tx
    .select({ teamId: teamMembers.teamId })
    .from(teamMembers)
    .where(eq(teamMembers.profileId, profileA));
  const shared = await tx
    .select({ teamId: teamMembers.teamId })
    .from(teamMembers)
    .where(and(eq(teamMembers.profileId, profileB), inArray(teamMembers.teamId, memberTeams)))
    .limit(1);

  return shared.length > 0;
}
