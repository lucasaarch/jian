import { createHash, randomUUID } from 'node:crypto';
import { type InlineMedia, type Run, type Sticker, stickerSchema } from '@jian/contracts';
import { type ToolSet, tool } from 'ai';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { GatewayError } from '../core/errors.js';
import type { Store } from '../storage/database.js';
import { stickers } from '../storage/schema.js';

/** How many a profile keeps. Past it, the least sent and oldest one makes room. */
const MAX_STICKERS = 200;
/** What one search offers the agent to choose from. */
const OFFERED = 20;

type StickerMedia = {
  describeSticker(profileId: string, data: string, signal: AbortSignal): Promise<string>;
  sendSticker(run: Run, data: string, toolCallId: string): Promise<unknown>;
};

type Row = typeof stickers.$inferSelect;

const toSticker = (row: Row): Sticker =>
  stickerSchema.parse({
    id: row.id,
    profileId: row.profileId,
    ...(row.description ? { description: row.description } : {}),
    uses: row.uses,
    createdAt: row.createdAt.toISOString(),
    ...(row.lastUsedAt ? { lastUsedAt: row.lastUsedAt.toISOString() } : {}),
  });

/**
 * The agent's own sticker collection, gathered from the chats it is in. WhatsApp does not give a
 * paired account's saved stickers to anything outside the app, so the collection is what people
 * sent: each image kept once, described once by the image-analysis model, and found again by
 * what it shows. The owner sees it under Stickers and removes what the agent should not use.
 */
export class Stickers {
  constructor(
    private readonly store: Store,
    private readonly media: StickerMedia,
  ) {}

  /** Keeps a received sticker; a new one is described in the background, never in the way. */
  async keep(profileId: string, input: InlineMedia): Promise<void> {
    if (input.mimeType !== 'image/webp') return;

    const hash = createHash('sha256').update(input.data).digest('hex');
    const [kept] = await this.store.db
      .insert(stickers)
      .values({ id: randomUUID(), profileId, hash, data: input.data })
      .onConflictDoNothing()
      .returning({ id: stickers.id });

    if (!kept) return;

    await this.trim(profileId);
    void this.describe(profileId, kept.id, input.data);
  }

  private async describe(profileId: string, id: string, data: string) {
    try {
      const description = await this.media.describeSticker(
        profileId,
        data,
        AbortSignal.timeout(60_000),
      );

      if (description)
        await this.store.db
          .update(stickers)
          .set({ description })
          .where(and(eq(stickers.profileId, profileId), eq(stickers.id, id)));
    } catch (error) {
      // Without a description it is still kept, and still offered when nothing matches better.
      console.error(
        `jian: sticker ${id} could not be described — ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
  }

  private async trim(profileId: string) {
    const extra = await this.store.db
      .select({ id: stickers.id })
      .from(stickers)
      .where(eq(stickers.profileId, profileId))
      .orderBy(desc(stickers.uses), desc(stickers.createdAt))
      .offset(MAX_STICKERS);

    for (const { id } of extra)
      await this.store.db
        .delete(stickers)
        .where(and(eq(stickers.profileId, profileId), eq(stickers.id, id)));
  }

  async list(profileId: string): Promise<Sticker[]> {
    const rows = await this.store.db
      .select()
      .from(stickers)
      .where(eq(stickers.profileId, profileId))
      .orderBy(desc(stickers.uses), desc(stickers.createdAt))
      .limit(MAX_STICKERS);

    return rows.map(toSticker);
  }

  private async row(profileId: string, id: string) {
    const [row] = await this.store.db
      .select()
      .from(stickers)
      .where(and(eq(stickers.profileId, profileId), eq(stickers.id, id)))
      .limit(1);

    if (!row) throw new GatewayError(404, 'Sticker not found');

    return row;
  }

  async image(profileId: string, id: string) {
    const row = await this.row(profileId, id);

    return { ...toSticker(row), mimeType: 'image/webp' as const, data: row.data };
  }

  async forget(profileId: string, id: string): Promise<Sticker> {
    const row = await this.row(profileId, id);

    await this.store.db
      .delete(stickers)
      .where(and(eq(stickers.profileId, profileId), eq(stickers.id, id)));

    return toSticker(row);
  }

  /** The stickers whose description shares a word with the query, best matched and most sent first. */
  async search(profileId: string, query?: string) {
    const words = [...new Set((query ?? '').toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [])].slice(
      0,
      8,
    );
    const score = words.length
      ? sql<number>`(${sql.join(
          words.map(
            (word) =>
              sql`(case when lower(coalesce(${stickers.description}, '')) like ${`%${word}%`} then 1 else 0 end)`,
          ),
          sql` + `,
        )})`
      : sql<number>`0`;
    const rows = await this.store.db
      .select({ id: stickers.id, description: stickers.description, uses: stickers.uses, score })
      .from(stickers)
      .where(eq(stickers.profileId, profileId))
      .orderBy(desc(score), desc(stickers.uses), asc(stickers.createdAt))
      .limit(OFFERED);

    return rows.map(({ id, description, uses }) => ({
      id,
      shows: description ?? 'not described yet',
      sent: uses,
    }));
  }

  tools(run: Run): ToolSet {
    return {
      find_stickers: tool({
        description:
          'Find stickers in your collection, gathered from the stickers people sent you, by what they show or the reaction they carry ("laughing", "thumbs up", "facepalm"). Returns ids with a short description.',
        inputSchema: z.object({ query: z.string().max(200).optional() }),
        execute: async ({ query }) => {
          const found = await this.search(run.profileId, query);

          return found.length
            ? { stickers: found }
            : { stickers: [], note: 'No stickers yet: they are kept as people send them.' };
        },
      }),
      send_sticker: tool({
        description:
          'Send a sticker from your collection in this conversation, by its id from find_stickers. It goes out as a sticker on WhatsApp and Telegram.',
        inputSchema: z.object({ stickerId: z.uuid() }),
        execute: async ({ stickerId }, options) => {
          const row = await this.row(run.profileId, stickerId);
          const sent = await this.media.sendSticker(run, row.data, options.toolCallId);

          await this.store.db
            .update(stickers)
            .set({ uses: sql`${stickers.uses} + 1`, lastUsedAt: new Date() })
            .where(and(eq(stickers.profileId, run.profileId), eq(stickers.id, stickerId)));

          return sent;
        },
      }),
    };
  }
}
