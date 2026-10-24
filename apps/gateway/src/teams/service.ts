import { randomUUID } from 'node:crypto';
import type { Team, TeamInput } from '@jian/contracts';
import { asc, eq, inArray } from 'drizzle-orm';
import { GatewayError } from '../core/errors.js';
import type { Queryable, Store } from '../storage/database.js';
import { profiles, teamMembers, teams } from '../storage/schema.js';
import { lockTeamMembership } from './membership.js';

export class Teams {
  constructor(
    private readonly store: Store,
    private readonly clock: () => number = Date.now,
  ) {}

  async list(): Promise<Team[]> {
    const rows = await this.store.db
      .select({
        id: teams.id,
        name: teams.name,
        description: teams.description,
        createdAt: teams.createdAt,
        updatedAt: teams.updatedAt,
        profileId: teamMembers.profileId,
      })
      .from(teams)
      .leftJoin(teamMembers, eq(teamMembers.teamId, teams.id))
      .orderBy(asc(teams.name), asc(teamMembers.profileId));
    const result = new Map<string, Team>();

    for (const row of rows) {
      let team = result.get(row.id);
      if (!team) {
        team = {
          id: row.id,
          name: row.name,
          description: row.description,
          profileIds: [],
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        };
        result.set(row.id, team);
      }
      if (row.profileId) team.profileIds.push(row.profileId);
    }

    return [...result.values()];
  }

  async create(input: TeamInput): Promise<Team> {
    return this.store.db.transaction(async (tx) => {
      await lockTeamMembership(tx);
      await this.assertProfiles(input.profileIds, tx);
      const now = new Date(this.clock());
      const [row] = await tx
        .insert(teams)
        .values({
          id: randomUUID(),
          name: input.name,
          description: input.description,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!row) throw new GatewayError(500, 'Team could not be created');
      if (input.profileIds.length) {
        await tx
          .insert(teamMembers)
          .values(input.profileIds.map((profileId) => ({ teamId: row.id, profileId })));
      }
      return {
        id: row.id,
        name: row.name,
        description: row.description,
        profileIds: input.profileIds,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    });
  }

  async update(id: string, input: TeamInput): Promise<Team> {
    return this.store.db.transaction(async (tx) => {
      await lockTeamMembership(tx);
      await this.assertProfiles(input.profileIds, tx);
      const now = new Date(this.clock());
      const [row] = await tx
        .update(teams)
        .set({ name: input.name, description: input.description, updatedAt: now })
        .where(eq(teams.id, id))
        .returning();
      if (!row) throw new GatewayError(404, 'Team not found');

      await tx.delete(teamMembers).where(eq(teamMembers.teamId, id));
      if (input.profileIds.length) {
        await tx
          .insert(teamMembers)
          .values(input.profileIds.map((profileId) => ({ teamId: id, profileId })));
      }

      return {
        id: row.id,
        name: row.name,
        description: row.description,
        profileIds: input.profileIds,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    });
  }

  async remove(id: string): Promise<{ id: string }> {
    return this.store.db.transaction(async (tx) => {
      await lockTeamMembership(tx);
      const [row] = await tx.delete(teams).where(eq(teams.id, id)).returning({ id: teams.id });
      if (!row) throw new GatewayError(404, 'Team not found');
      return row;
    });
  }

  private async assertProfiles(ids: string[], tx: Queryable): Promise<void> {
    if (ids.length === 0) return;
    const found = await tx
      .select({ id: profiles.id })
      .from(profiles)
      .where(inArray(profiles.id, ids));
    if (found.length !== ids.length)
      throw new GatewayError(400, 'One or more profiles do not exist');
  }
}
