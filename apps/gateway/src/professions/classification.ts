import { type ProfessionPreview, professionPreviewInputSchema } from '@jian/contracts';
import { and, count, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { GatewayError } from '../core/errors.js';
import { recordEvent } from '../core/events.js';
import type { ProfileParams } from '../http/params.js';
import type { ProfileReader } from '../profiles/port.js';
import { insertRevision } from '../profiles/repository.js';
import type { Store } from '../storage/database.js';
import {
  channels,
  profiles,
  remoteMachines,
  remoteTasks,
  runs,
  schedules,
  sessions,
  subscriptions,
} from '../storage/schema.js';
import { findProfession } from './catalog.js';
import { profileAuthority } from './effective.js';

/**
 * Read-only preparation, deliberately not a classification primitive. A profile lock does
 * not quiesce remote effects or async workers. Never use this result as a write precondition
 * or consent token: eventual classification must coordinate admission and recheck all state.
 */
export async function previewProfession(
  deps: { store: Store; profiles: ProfileReader },
  profileId: string,
  input: unknown,
): Promise<ProfessionPreview> {
  const { professionId, expectedVersion } = professionPreviewInputSchema.parse(input);
  const definition = findProfession(professionId);
  if (!definition) throw new GatewayError(400, 'Unknown profession');

  return deps.store.transaction(profileId, async (tx) => {
    const profile = await deps.profiles.profile(profileId, tx);
    if (profile.version !== expectedVersion) {
      throw new GatewayError(409, 'Profile changed; refresh the classification preview');
    }
    const runCounts = await tx
      .select({ status: runs.status, count: count() })
      .from(runs)
      .where(eq(runs.profileId, profileId))
      .groupBy(runs.status);
    const forStatus = (status: typeof runs.$inferSelect.status) =>
      runCounts.find((row) => row.status === status)?.count ?? 0;
    const [historical] = await tx
      .select({ count: count() })
      .from(runs)
      .where(
        and(
          eq(runs.profileId, profileId),
          isNull(runs.authority),
          inArray(runs.status, ['completed', 'failed', 'interrupted', 'cancelled']),
        ),
      );
    const [executing] = await tx
      .select({ count: count() })
      .from(runs)
      .where(and(eq(runs.profileId, profileId), isNotNull(runs.executionOwner)));
    const [reports] = await tx
      .select({ count: count() })
      .from(runs)
      .where(
        and(
          eq(runs.profileId, profileId),
          isNotNull(runs.subagent),
          isNull(runs.subagentReportedAt),
          inArray(runs.status, ['completed', 'failed', 'interrupted']),
        ),
      );
    const [remote] = await tx
      .select({ count: count() })
      .from(remoteTasks)
      .where(
        and(
          eq(remoteTasks.profileId, profileId),
          inArray(remoteTasks.status, ['queued', 'running']),
        ),
      );
    const [runningRemote] = await tx
      .select({ count: count() })
      .from(remoteTasks)
      .where(and(eq(remoteTasks.profileId, profileId), eq(remoteTasks.status, 'running')));
    const [scheduled] = await tx
      .select({ count: count() })
      .from(schedules)
      .where(and(eq(schedules.profileId, profileId), eq(schedules.enabled, true)));
    const [subscribed] = await tx
      .select({ count: count() })
      .from(subscriptions)
      .where(and(eq(subscriptions.profileId, profileId), eq(subscriptions.enabled, true)));
    const [connected] = await tx
      .select({ count: count() })
      .from(channels)
      .where(and(eq(channels.profileId, profileId), isNull(channels.revokedAt)));
    const [objectives] = await tx
      .select({ count: count() })
      .from(sessions)
      .where(
        and(
          eq(sessions.profileId, profileId),
          sql`${sessions.objective}->>'status' IN ('open', 'blocked')`,
        ),
      );
    const [machines] = await tx
      .select({ count: count() })
      .from(remoteMachines)
      .where(sql`${remoteMachines.allowedProfileIds} @> ${JSON.stringify([profileId])}::jsonb`);

    const affected = {
      queuedRuns: forStatus('queued'),
      runningRuns: forStatus('running'),
      waitingRuns: forStatus('waiting'),
      unsettledExecutions: executing?.count ?? 0,
      pendingWorkerReports: reports?.count ?? 0,
      historicalRunsWithoutAuthority: historical?.count ?? 0,
      pendingRemoteTasks: remote?.count ?? 0,
      runningRemoteTasks: runningRemote?.count ?? 0,
      enabledSchedules: scheduled?.count ?? 0,
      enabledSubscriptions: subscribed?.count ?? 0,
      liveChannels: connected?.count ?? 0,
      openObjectives: objectives?.count ?? 0,
      customSkills: profile.skills.length,
      remoteMachines: machines?.count ?? 0,
      learning: profile.learnFromWork,
      peerCalls: profile.reachableByAgents,
    };
    const blockers: ProfessionPreview['blockers'] = [];
    if (profile.professionId !== null) blockers.push('already_classified');
    if (
      affected.runningRuns +
        affected.waitingRuns +
        affected.unsettledExecutions +
        affected.pendingWorkerReports +
        (runningRemote?.count ?? 0) >
      0
    ) {
      blockers.push('unsettled_work');
    }
    return {
      profileId,
      profileVersion: profile.version,
      professionId,
      policyVersion: definition.policyVersion,
      assignable: blockers.length === 0,
      blockers,
      configurationCapabilities: profileAuthority({ ...profile, professionId })?.capabilities ?? [],
      incompatibleMcpServers: profile.mcpServers
        .filter(
          (server) =>
            !definition.capabilities.includes(
              server.transport === 'stdio' ? 'mcp.stdio' : 'mcp.http',
            ),
        )
        .map((server) => server.name),
      affected,
    };
  });
}

export async function assignProfession(
  deps: { store: Store; profiles: ProfileReader; clock?: () => number },
  profileId: string,
  input: unknown,
) {
  const { professionId, expectedVersion } = professionPreviewInputSchema.parse(input);
  const definition = findProfession(professionId);
  if (!definition) throw new GatewayError(400, 'Unknown profession');
  const clock = deps.clock ?? Date.now;
  const now = new Date(clock()).toISOString();

  return deps.store.transaction(profileId, async (tx) => {
    const profile = await deps.profiles.profile(profileId, tx);
    if (profile.version !== expectedVersion) {
      throw new GatewayError(409, 'Profile changed; reload before assigning a profession');
    }
    if (profile.professionId !== null) {
      throw new GatewayError(409, 'A profile profession can only be assigned once');
    }
    const [unsettled] = await tx
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.profileId, profileId), inArray(runs.status, ['running', 'waiting'])))
      .limit(1);
    const [owned] = await tx
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.profileId, profileId), isNotNull(runs.executionOwner)))
      .limit(1);
    const [remote] = await tx
      .select({ id: remoteTasks.id })
      .from(remoteTasks)
      .where(and(eq(remoteTasks.profileId, profileId), eq(remoteTasks.status, 'running')))
      .limit(1);
    const [reports] = await tx
      .select({ id: runs.id })
      .from(runs)
      .where(
        and(
          eq(runs.profileId, profileId),
          isNotNull(runs.subagent),
          isNull(runs.subagentReportedAt),
          inArray(runs.status, ['completed', 'failed', 'interrupted']),
        ),
      )
      .limit(1);
    if (unsettled || owned || remote || reports) {
      throw new GatewayError(409, 'Settle running, waiting, and Remote work before assignment');
    }

    const assigned = {
      ...profile,
      professionId,
      version: profile.version + 1,
      updatedAt: now,
    };
    await tx
      .update(profiles)
      .set({ professionId, version: assigned.version, updatedAt: new Date(now) })
      .where(eq(profiles.id, profileId));
    await insertRevision(tx, assigned);
    // Preserve old queued requests, but bind them to the owner's explicit authority selection
    // before the worker can claim them. The shared profile lock serializes this with claim().
    const authority = profileAuthority(assigned);
    await tx
      .update(runs)
      .set({ profileVersion: assigned.version, authority })
      .where(and(eq(runs.profileId, profileId), eq(runs.status, 'queued')));
    await tx
      .update(subscriptions)
      .set({
        enabled: false,
        lastError: 'Classified subscription authority requires owner review',
        updatedAt: new Date(now),
      })
      .where(and(eq(subscriptions.profileId, profileId), eq(subscriptions.enabled, true)));
    await recordEvent(tx, clock, profileId, 'profile.profession.assigned', {
      profileId,
      professionId,
      policyVersion: definition.policyVersion,
      version: assigned.version,
    });
    return assigned;
  });
}

export function registerProfessionPreviewRoutes(
  app: FastifyInstance,
  deps: { store: Store; profiles: ProfileReader; clock?: () => number },
): void {
  app.post<{ Params: ProfileParams }>(
    '/v1/profiles/:profileId/profession/preview',
    async (request) => previewProfession(deps, request.params.profileId, request.body),
  );
  app.post<{ Params: ProfileParams }>(
    '/v1/profiles/:profileId/profession/assign',
    async (request) => assignProfession(deps, request.params.profileId, request.body),
  );
}
