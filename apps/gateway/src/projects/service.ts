import { randomUUID } from 'node:crypto';
import type { Profile } from '@jian/contracts';
import { type Project, projectInputSchema } from '@jian/contracts';
import { and, asc, eq } from 'drizzle-orm';
import { type Clock, nowIso } from '../core/clock.js';
import { GatewayError } from '../core/errors.js';
import type { Queryable, Store } from '../storage/database.js';
import { projects } from '../storage/schema.js';

type ProfileLookup = { profile(id: string, reader?: Queryable): Promise<Profile> };
type GitHubRepositoryLookup = {
  repository(
    accountId: string,
    repositoryId: number,
  ): Promise<{ cloneUrl: string; fullName: string }>;
};

function toProject(row: typeof projects.$inferSelect): Project {
  return {
    id: row.id,
    profileId: row.profileId,
    name: row.name,
    repositoryUrl: row.repositoryUrl,
    ...(row.githubAccountId && row.githubRepositoryId
      ? { githubAccountId: row.githubAccountId, githubRepositoryId: row.githubRepositoryId }
      : {}),
    createdAt: row.createdAt.toISOString(),
  };
}

export class Projects {
  constructor(
    private readonly store: Store,
    private readonly profiles: ProfileLookup,
    private readonly clock: Clock = Date.now,
    private readonly github?: GitHubRepositoryLookup,
  ) {}

  async list(profileId: string) {
    await this.profiles.profile(profileId);
    const rows = await this.store.db
      .select()
      .from(projects)
      .where(eq(projects.profileId, profileId))
      .orderBy(asc(projects.name));
    return rows.map(toProject);
  }

  /**
   * The agent's project for a repository, opened the first time it is chosen. A repository id
   * is GitHub's own and global, so the same repository reached through another account is the
   * same project; it moves to the account it was chosen through, which can reach it now.
   */
  async ensure(profileId: string, input: unknown) {
    const data = projectInputSchema.parse(input);
    await this.profiles.profile(profileId);
    if (!this.github) throw new GatewayError(503, 'GitHub integration is not available.');
    const repository = await this.github.repository(data.githubAccountId, data.githubRepositoryId);

    return this.store.transaction(profileId, async (tx) => {
      await this.profiles.profile(profileId, tx);
      const [existing] = await tx
        .select()
        .from(projects)
        .where(
          and(
            eq(projects.profileId, profileId),
            eq(projects.githubRepositoryId, data.githubRepositoryId),
          ),
        )
        .limit(1);

      if (existing) {
        if (existing.githubAccountId === data.githubAccountId) return toProject(existing);
        const [moved] = await tx
          .update(projects)
          .set({ githubAccountId: data.githubAccountId })
          .where(eq(projects.id, existing.id))
          .returning();
        return toProject(moved ?? existing);
      }

      const project = {
        id: randomUUID(),
        profileId,
        name: repository.fullName,
        repositoryUrl: repository.cloneUrl,
        githubAccountId: data.githubAccountId,
        githubRepositoryId: data.githubRepositoryId,
        createdAt: new Date(nowIso(this.clock)),
      };
      await tx.insert(projects).values(project);
      return toProject(project);
    });
  }
}
