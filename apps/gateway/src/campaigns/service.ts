import { randomUUID } from 'node:crypto';
import { type SalesCampaign, salesCampaignInputSchema } from '@jian/contracts';
import { and, asc, desc, eq, ilike, isNull, or } from 'drizzle-orm';
import { GatewayError } from '../core/errors.js';
import { recordEvent } from '../core/events.js';
import type { ProfileReader } from '../profiles/port.js';
import type { Store } from '../storage/database.js';
import { channels, contacts, salesCampaigns, sessions } from '../storage/schema.js';

const record = (row: typeof salesCampaigns.$inferSelect): SalesCampaign => ({
  ...row,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

export class SalesCampaigns {
  constructor(
    private readonly store: Store,
    private readonly profiles: ProfileReader,
    private readonly clock: () => number = Date.now,
  ) {}

  async list(profileId: string): Promise<SalesCampaign[]> {
    await this.profiles.profile(profileId);
    const rows = await this.store.db
      .select()
      .from(salesCampaigns)
      .where(eq(salesCampaigns.profileId, profileId))
      .orderBy(desc(salesCampaigns.updatedAt), asc(salesCampaigns.name));
    return rows.map(record);
  }

  async searchForAgent(profileId: string, query?: string): Promise<SalesCampaign[]> {
    await this.profiles.profile(profileId);
    const search = query?.trim();
    const where = search
      ? and(
          eq(salesCampaigns.profileId, profileId),
          or(
            ilike(salesCampaigns.name, `%${search}%`),
            ilike(salesCampaigns.description, `%${search}%`),
          ),
        )
      : eq(salesCampaigns.profileId, profileId);
    const rows = await this.store.db
      .select()
      .from(salesCampaigns)
      .where(where)
      .orderBy(desc(salesCampaigns.updatedAt), asc(salesCampaigns.name))
      .limit(5);
    return rows.map(record);
  }

  async create(profileId: string, input: unknown): Promise<SalesCampaign> {
    const campaign = salesCampaignInputSchema.parse(input);
    return this.store.transaction(profileId, async (tx) => {
      await this.profiles.profile(profileId, tx);
      const created = await this.insert(tx, profileId, campaign);
      await recordEvent(tx, this.clock, profileId, 'campaign.created', { id: created.id });
      return created;
    });
  }

  async createForAgent(
    profileId: string,
    sessionId: string,
    input: unknown,
  ): Promise<SalesCampaign> {
    const campaign = salesCampaignInputSchema.parse(input);
    return this.store.transaction(profileId, async (tx) => {
      await this.assertTrustedRequester(tx, profileId, sessionId);
      await this.profiles.profile(profileId, tx);
      const created = await this.insert(tx, profileId, campaign);
      await recordEvent(tx, this.clock, profileId, 'campaign.created', { id: created.id });
      return created;
    });
  }

  async update(profileId: string, campaignId: string, input: unknown): Promise<SalesCampaign> {
    const campaign = salesCampaignInputSchema.parse(input);
    return this.store.transaction(profileId, async (tx) => {
      await this.profiles.profile(profileId, tx);
      const updated = await this.updateRecord(tx, profileId, campaignId, campaign);
      await recordEvent(tx, this.clock, profileId, 'campaign.updated', { id: campaignId });
      return updated;
    });
  }

  async updateForAgent(
    profileId: string,
    sessionId: string,
    campaignId: string,
    input: unknown,
  ): Promise<SalesCampaign> {
    const campaign = salesCampaignInputSchema.parse(input);
    return this.store.transaction(profileId, async (tx) => {
      await this.assertTrustedRequester(tx, profileId, sessionId);
      await this.profiles.profile(profileId, tx);
      const updated = await this.updateRecord(tx, profileId, campaignId, campaign);
      await recordEvent(tx, this.clock, profileId, 'campaign.updated', { id: campaignId });
      return updated;
    });
  }

  async remove(profileId: string, campaignId: string): Promise<{ id: string }> {
    return this.store.transaction(profileId, async (tx) => {
      await this.profiles.profile(profileId, tx);
      const removed = await this.removeRecord(tx, profileId, campaignId);
      await recordEvent(tx, this.clock, profileId, 'campaign.deleted', { id: removed.id });
      return removed;
    });
  }

  async removeForAgent(
    profileId: string,
    sessionId: string,
    campaignId: string,
  ): Promise<{ id: string }> {
    return this.store.transaction(profileId, async (tx) => {
      await this.assertTrustedRequester(tx, profileId, sessionId);
      await this.profiles.profile(profileId, tx);
      const removed = await this.removeRecord(tx, profileId, campaignId);
      await recordEvent(tx, this.clock, profileId, 'campaign.deleted', { id: removed.id });
      return removed;
    });
  }

  private async assertTrustedRequester(
    tx: Store['db'],
    profileId: string,
    sessionId: string,
  ): Promise<void> {
    const [session] = await tx
      .select({ channel: sessions.channel, scope: sessions.scope })
      .from(sessions)
      .where(and(eq(sessions.profileId, profileId), eq(sessions.id, sessionId)))
      .limit(1);
    if (session?.channel === 'gateway') return;
    if (session?.scope !== 'direct')
      throw new GatewayError(
        403,
        'Campaign changes require the owner or a directly approved contact',
      );

    const [contact] = await tx
      .select({ id: contacts.id })
      .from(contacts)
      .innerJoin(channels, eq(channels.id, contacts.channelId))
      .where(
        and(
          eq(contacts.profileId, profileId),
          eq(contacts.sessionId, sessionId),
          eq(contacts.scope, 'direct'),
          eq(contacts.status, 'approved'),
          isNull(channels.revokedAt),
        ),
      )
      .limit(1);
    if (!contact)
      throw new GatewayError(
        403,
        'Campaign changes require the owner or a directly approved contact',
      );
  }

  private async insert(
    tx: Store['db'],
    profileId: string,
    campaign: ReturnType<typeof salesCampaignInputSchema.parse>,
  ): Promise<SalesCampaign> {
    const now = new Date(this.clock());
    const [row] = await tx
      .insert(salesCampaigns)
      .values({ id: randomUUID(), profileId, ...campaign, createdAt: now, updatedAt: now })
      .returning();
    if (!row) throw new GatewayError(500, 'Sales campaign could not be created');
    return record(row);
  }

  private async updateRecord(
    tx: Store['db'],
    profileId: string,
    campaignId: string,
    campaign: ReturnType<typeof salesCampaignInputSchema.parse>,
  ): Promise<SalesCampaign> {
    const [row] = await tx
      .update(salesCampaigns)
      .set({ ...campaign, updatedAt: new Date(this.clock()) })
      .where(and(eq(salesCampaigns.profileId, profileId), eq(salesCampaigns.id, campaignId)))
      .returning();
    if (!row) throw new GatewayError(404, 'Sales campaign not found');
    return record(row);
  }

  private async removeRecord(
    tx: Store['db'],
    profileId: string,
    campaignId: string,
  ): Promise<{ id: string }> {
    const [row] = await tx
      .delete(salesCampaigns)
      .where(and(eq(salesCampaigns.profileId, profileId), eq(salesCampaigns.id, campaignId)))
      .returning({ id: salesCampaigns.id });
    if (!row) throw new GatewayError(404, 'Sales campaign not found');
    return row;
  }
}
