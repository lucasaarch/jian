import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { readEvents } from '../../src/core/event-feed.js';
import { findRun } from '../../src/runs/repository.js';
import type { Store } from '../../src/storage/database.js';
import {
  channelAuth,
  channelConnections,
  channelInbox,
  projects,
  runs,
  secrets,
} from '../../src/storage/schema.js';

/** What a profile recorded, for a test that asserts on the durable feed. */
export async function events(store: Store, profileId: string, after = 0, limit = 1000) {
  return readEvents(store.db, profileId, after, limit);
}

/** Direct row readers for assertions about what the database actually holds. */
export async function runRows(store: Store, profileId: string) {
  return store.db.select().from(runs).where(eq(runs.profileId, profileId));
}

export async function secretRow(store: Store, profileId: string, name: string) {
  const [row] = await store.db
    .select()
    .from(secrets)
    .where(and(eq(secrets.profileId, profileId), eq(secrets.name, name)))
    .limit(1);

  return row ?? null;
}

export async function connectionRow(store: Store, channelId: string) {
  const [row] = await store.db
    .select()
    .from(channelConnections)
    .where(eq(channelConnections.channelId, channelId))
    .limit(1);

  return row ?? null;
}

export async function authRow(store: Store, channelId: string) {
  const [row] = await store.db
    .select()
    .from(channelAuth)
    .where(eq(channelAuth.channelId, channelId))
    .limit(1);

  return row ?? null;
}

export async function pendingInbox(store: Store) {
  return store.db.select().from(channelInbox).where(eq(channelInbox.status, 'pending'));
}

/** The oldest run a profile still has queued, hydrated as the services would return it. */
export async function queuedRun(store: Store, profileId: string) {
  const [row] = await store.db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.profileId, profileId), eq(runs.status, 'queued')))
    .orderBy(runs.createdAt)
    .limit(1);

  return row ? findRun(store.db, profileId, row.id) : null;
}

/** A project as it is stored, for a test that only needs one to exist. */
export async function projectRow(store: Store, profileId: string, repositoryUrl: string) {
  const project = {
    id: randomUUID(),
    profileId,
    name: repositoryUrl.replace(/^.*[:/]([^/]+\/[^/]+?)(\.git)?$/, '$1'),
    repositoryUrl,
  };
  await store.db.insert(projects).values(project);
  return project;
}
