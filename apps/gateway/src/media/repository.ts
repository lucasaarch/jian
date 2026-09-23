import { and, eq } from 'drizzle-orm';
import { GatewayError } from '../core/errors.js';
import type { Queryable } from '../storage/database.js';
import { mediaAssets } from '../storage/schema.js';

export type MediaAsset = typeof mediaAssets.$inferSelect;
export const mediaMarker = (id: string) => `[Attached media: ${id}]`;
export const mediaIdsIn = (text: string) =>
  [...text.matchAll(/\[Attached media: ([0-9a-f-]{36})\]/g)].map((match) => match[1] ?? '');

export async function findMedia(db: Queryable, profileId: string, id: string) {
  const [row] = await db
    .select()
    .from(mediaAssets)
    .where(and(eq(mediaAssets.profileId, profileId), eq(mediaAssets.id, id)))
    .limit(1);
  if (!row) throw new GatewayError(404, 'Media not found');
  return row;
}

export async function bindMedia(
  db: Queryable,
  profileId: string,
  sessionId: string,
  ids: string[],
  runId?: string,
) {
  for (const id of ids) {
    const asset = await findMedia(db, profileId, id);
    if (asset.sessionId !== sessionId || (runId && asset.runId && asset.runId !== runId))
      throw new GatewayError(409, 'Media belongs to another conversation or request');
    if (runId)
      await db
        .update(mediaAssets)
        .set({ runId })
        .where(and(eq(mediaAssets.profileId, profileId), eq(mediaAssets.id, id)));
  }
}

export async function releaseHeldMedia(
  db: Queryable,
  profileId: string,
  contactId: string,
  sessionId: string,
) {
  const rows = await db
    .update(mediaAssets)
    .set({ sessionId })
    .where(
      and(
        eq(mediaAssets.profileId, profileId),
        eq(mediaAssets.contactId, contactId),
        eq(mediaAssets.held, true),
      ),
    )
    .returning({ id: mediaAssets.id });
  return rows.map((row) => row.id).sort();
}
