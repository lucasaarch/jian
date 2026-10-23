import type { Run } from '@jian/contracts';
import { and, eq, ne } from 'drizzle-orm';
import type { Queryable } from '../storage/database.js';
import { runs } from '../storage/schema.js';

/** Read after the message snapshot so newly persisted queued ingress cannot enroll in this run. */
export async function deferredRunIds(db: Queryable, run: Pick<Run, 'id' | 'profileId'>) {
  const queued = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.profileId, run.profileId), eq(runs.status, 'queued'), ne(runs.id, run.id)));
  return new Set(queued.map(({ id }) => id));
}
