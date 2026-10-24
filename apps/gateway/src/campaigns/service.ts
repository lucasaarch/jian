import { randomUUID } from 'node:crypto';
import {
  type SalesCampaign,
  type SalesCampaignOutcome,
  type SalesCampaignReport,
  salesCampaignInputSchema,
  salesCampaignPlaybookSchema,
  salesCampaignReportQuerySchema,
  salesCampaignReportSchema,
  salesCampaignRulesSchema,
} from '@jian/contracts';
import { and, asc, desc, eq, gte, ilike, isNull, lte, or, sql } from 'drizzle-orm';
import { GatewayError } from '../core/errors.js';
import { recordEvent } from '../core/events.js';
import type { ProfileReader } from '../profiles/port.js';
import type { Store } from '../storage/database.js';
import {
  channels,
  contacts,
  salesCampaignMetrics,
  salesCampaigns,
  sessions,
} from '../storage/schema.js';

const GENERAL_CAMPAIGN_ID = '00000000-0000-0000-0000-000000000000';
const metricFields = ['lookups', 'qualified', 'notQualified', 'escalated'] as const;
type MetricField = (typeof metricFields)[number];

const record = (row: typeof salesCampaigns.$inferSelect): SalesCampaign => ({
  ...row,
  rules: salesCampaignRulesSchema.parse(row.rules),
  playbook: salesCampaignPlaybookSchema.parse(row.playbook),
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
    return this.store.transaction(profileId, async (tx) => {
      await this.profiles.profile(profileId, tx);
      const search = query?.trim();
      const today = new Date(this.clock()).toISOString().slice(0, 10);
      const filters = [
        eq(salesCampaigns.profileId, profileId),
        eq(salesCampaigns.active, true),
        or(isNull(salesCampaigns.startsOn), lte(salesCampaigns.startsOn, today)),
        or(isNull(salesCampaigns.endsOn), gte(salesCampaigns.endsOn, today)),
      ];
      const searchFilter = search
        ? or(
            ilike(salesCampaigns.name, `%${search}%`),
            ilike(salesCampaigns.description, `%${search}%`),
            sql`${salesCampaigns.rules}::text ilike ${`%${search}%`}`,
            sql`${salesCampaigns.playbook}::text ilike ${`%${search}%`}`,
          )
        : undefined;
      const find = (includeSearch: boolean) =>
        tx
          .select()
          .from(salesCampaigns)
          .where(and(...filters, ...(includeSearch && searchFilter ? [searchFilter] : [])))
          .orderBy(desc(salesCampaigns.updatedAt), asc(salesCampaigns.name))
          .limit(5);
      let rows = await find(true);
      // A literal miss should not hide the active campaign catalog from an agent.
      if (search && rows.length === 0) rows = await find(false);
      const campaigns = rows.map(record);
      for (const campaign of campaigns)
        await this.increment(tx, profileId, campaign.id, campaign.name, 'lookups');
      if (campaigns.length)
        await recordEvent(tx, this.clock, profileId, 'campaign.metrics', {
          campaignIds: campaigns.map(({ id }) => id),
          metric: 'lookups',
        });
      return campaigns;
    });
  }

  async report(profileId: string, input: unknown): Promise<SalesCampaignReport> {
    const { days } = salesCampaignReportQuerySchema.parse(input);
    await this.profiles.profile(profileId);
    const through = new Date(this.clock()).toISOString().slice(0, 10);
    const first = new Date(`${through}T00:00:00.000Z`);
    first.setUTCDate(first.getUTCDate() - days + 1);
    const since = first.toISOString().slice(0, 10);
    const rows = await this.store.db
      .select({
        campaignId: salesCampaignMetrics.campaignId,
        campaignName: salesCampaignMetrics.campaignName,
        latestDay: sql<string>`max(${salesCampaignMetrics.day})`,
        lookups: sql<number>`sum(${salesCampaignMetrics.lookups})`.mapWith(Number),
        qualified: sql<number>`sum(${salesCampaignMetrics.qualified})`.mapWith(Number),
        notQualified: sql<number>`sum(${salesCampaignMetrics.notQualified})`.mapWith(Number),
        escalated: sql<number>`sum(${salesCampaignMetrics.escalated})`.mapWith(Number),
      })
      .from(salesCampaignMetrics)
      .where(
        and(
          eq(salesCampaignMetrics.profileId, profileId),
          gte(salesCampaignMetrics.day, since),
          lte(salesCampaignMetrics.day, through),
        ),
      )
      .groupBy(salesCampaignMetrics.campaignId, salesCampaignMetrics.campaignName);
    const totals = new Map<
      string,
      {
        campaignId: string | null;
        campaignName: string;
        lookups: number;
        qualified: number;
        notQualified: number;
        escalated: number;
        latestDay: string;
      }
    >();
    for (const row of rows) {
      const total = totals.get(row.campaignId) ?? {
        campaignId: row.campaignId === GENERAL_CAMPAIGN_ID ? null : row.campaignId,
        campaignName: row.campaignName,
        lookups: 0,
        qualified: 0,
        notQualified: 0,
        escalated: 0,
        latestDay: row.latestDay,
      };
      total.lookups += row.lookups;
      total.qualified += row.qualified;
      total.notQualified += row.notQualified;
      total.escalated += row.escalated;
      if (row.latestDay > total.latestDay) {
        total.latestDay = row.latestDay;
        total.campaignName = row.campaignName;
      }
      totals.set(row.campaignId, total);
    }
    const campaigns = await this.store.db
      .select({ id: salesCampaigns.id, name: salesCampaigns.name })
      .from(salesCampaigns)
      .where(eq(salesCampaigns.profileId, profileId));
    for (const campaign of campaigns) {
      const total = totals.get(campaign.id);
      if (total) total.campaignName = campaign.name;
      else
        totals.set(campaign.id, {
          campaignId: campaign.id,
          campaignName: campaign.name,
          latestDay: through,
          lookups: 0,
          qualified: 0,
          notQualified: 0,
          escalated: 0,
        });
    }
    return salesCampaignReportSchema.parse({
      days,
      since,
      through,
      campaigns: [...totals.values()]
        .map(({ latestDay: _latestDay, ...campaign }) => campaign)
        .sort((a, b) => b.qualified - a.qualified),
    });
  }

  /** Stores counts by campaign/day only. Conversation and customer identifiers never enter the row. */
  async recordOutcome(
    profileId: string,
    campaignId: string | undefined,
    outcome: SalesCampaignOutcome,
  ): Promise<void> {
    await this.store.transaction(profileId, async (tx) => {
      await this.profiles.profile(profileId, tx);
      const [campaign] = campaignId
        ? await tx
            .select({ id: salesCampaigns.id, name: salesCampaigns.name })
            .from(salesCampaigns)
            .where(and(eq(salesCampaigns.profileId, profileId), eq(salesCampaigns.id, campaignId)))
            .limit(1)
        : [];
      if (campaignId && !campaign) throw new GatewayError(404, 'Sales campaign not found');
      const id = campaign?.id ?? GENERAL_CAMPAIGN_ID;
      const name = campaign?.name ?? 'General sales';
      await this.increment(
        tx,
        profileId,
        id,
        name,
        outcome === 'not_qualified' ? 'notQualified' : outcome,
      );
      await recordEvent(tx, this.clock, profileId, 'campaign.metrics', {
        campaignId: campaign?.id ?? null,
        metric: outcome,
      });
    });
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

  private async increment(
    tx: Store['db'],
    profileId: string,
    campaignId: string,
    campaignName: string,
    metric: MetricField,
  ): Promise<void> {
    const values = {
      profileId,
      campaignId,
      campaignName,
      day: new Date(this.clock()).toISOString().slice(0, 10),
      lookups: 0,
      qualified: 0,
      notQualified: 0,
      escalated: 0,
      [metric]: 1,
    };
    await tx
      .insert(salesCampaignMetrics)
      .values(values)
      .onConflictDoUpdate({
        target: [
          salesCampaignMetrics.profileId,
          salesCampaignMetrics.campaignId,
          salesCampaignMetrics.day,
        ],
        set: {
          campaignName,
          [metric]: sql`${salesCampaignMetrics[metric]} + 1`,
        },
      });
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
