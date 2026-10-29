import { randomUUID } from 'node:crypto';
import type { Profile } from '@jian/contracts';
import { type Project, projectInputSchema } from '@jian/contracts';
import { asc, eq } from 'drizzle-orm';
import { type Clock, nowIso } from '../core/clock.js';
import { GatewayError } from '../core/errors.js';
import type { Queryable, Store } from '../storage/database.js';
import { projects } from '../storage/schema.js';

type ProfileLookup = { profile(id: string, reader?: Queryable): Promise<Profile> };
type GitHubRepositoryLookup = {
  repository(accountId: string, repositoryId: number): Promise<{ cloneUrl: string }>;
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

  async create(profileId: string, input: unknown) {
    const data = projectInputSchema.parse(input);
    await this.profiles.profile(profileId);
    const repository =
      data.githubAccountId && data.githubRepositoryId
        ? await this.github?.repository(data.githubAccountId, data.githubRepositoryId)
        : undefined;
    if (data.githubAccountId && !repository) {
      throw new GatewayError(503, 'GitHub integration is not available.');
    }
    const repositoryUrl = repository?.cloneUrl ?? data.repositoryUrl;
    if (!repositoryUrl) throw new GatewayError(400, 'Choose a repository for this project.');
    return this.store.transaction(profileId, async (tx) => {
      await this.profiles.profile(profileId, tx);
      const project = {
        id: randomUUID(),
        profileId,
        name: data.name,
        repositoryUrl,
        githubAccountId: data.githubAccountId ?? null,
        githubRepositoryId: data.githubRepositoryId ?? null,
        createdAt: new Date(nowIso(this.clock)),
      };
      await tx.insert(projects).values(project);
      return toProject(project);
    });
  }
}
