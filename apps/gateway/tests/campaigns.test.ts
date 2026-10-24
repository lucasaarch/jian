import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { channels, contacts, sessions } from '../src/storage/schema.js';
import { testServices } from './helpers/services.js';

const profileInput = {
  name: 'Aiko',
  instructions: 'Help customers with approved sales campaigns.',
  professionId: 'attendant',
};

describe('sales campaigns', () => {
  it('lets the owner and directly approved contacts manage campaigns, but rejects other sessions', async () => {
    const services = await testServices();
    const profile = await services.profiles.createProfile(profileInput);
    const ownerSessionId = randomUUID();
    const contactSessionId = randomUUID();
    const groupSessionId = randomUUID();
    const channelId = randomUUID();

    await services.store.db.insert(sessions).values([
      { id: ownerSessionId, profileId: profile.id, channel: 'gateway' },
      { id: contactSessionId, profileId: profile.id, channel: 'telegram', scope: 'direct' },
      { id: groupSessionId, profileId: profile.id, channel: 'telegram', scope: 'group' },
    ]);
    await services.store.db.insert(channels).values({
      id: channelId,
      profileId: profile.id,
      type: 'telegram',
      webhookTokenHash: randomUUID(),
    });
    await services.store.db.insert(contacts).values({
      id: randomUUID(),
      profileId: profile.id,
      channelId,
      scope: 'direct',
      chatId: 'telegram-chat-1',
      actorId: 'telegram-user-1',
      status: 'approved',
      sessionId: contactSessionId,
    });

    const campaigns = services.salesCampaigns;
    const details = {
      name: 'Spring offer',
      description: 'The starter bundle costs $49 through October 31.',
    };
    const created = await campaigns.createForAgent(profile.id, ownerSessionId, details);
    expect(await campaigns.searchForAgent(profile.id, 'October')).toEqual([created]);

    await expect(
      campaigns.createForAgent(profile.id, groupSessionId, {
        name: 'Untrusted request',
        description: 'Should be rejected.',
      }),
    ).rejects.toThrow('directly approved contact');

    const updated = await campaigns.updateForAgent(profile.id, contactSessionId, created.id, {
      name: 'Spring offer updated',
      description: 'The starter bundle costs $45 through October 31.',
      rules: {
        productOrService: 'Starter bundle',
        offer: '20% off',
        price: '$45',
        audience: 'New customers',
        benefits: 'Onboarding included',
        eligibility: 'First-time customers only',
        terms: 'Cannot combine with another offer',
        callToAction: 'Ask if they want to order',
      },
      playbook: {
        opening: 'Ask what they are looking for.',
        discoveryQuestions: ['What do you need?'],
        qualificationCriteria: ['The customer is new.'],
        objectionHandling: 'Explain the value without pressure.',
        closing: 'Offer to help place an order.',
      },
      active: true,
      startsOn: '2026-10-01',
      endsOn: '2026-10-31',
    });
    expect(await campaigns.list(profile.id)).toEqual([updated]);
    expect(await campaigns.searchForAgent(profile.id, 'first-time')).toEqual([updated]);
    await campaigns.recordOutcome(profile.id, updated.id, 'qualified');
    await campaigns.removeForAgent(profile.id, contactSessionId, updated.id);
    expect(await campaigns.list(profile.id)).toEqual([]);
    const report = await campaigns.report(profile.id, { days: 30 });
    expect(report.campaigns).toEqual([
      {
        campaignId: updated.id,
        campaignName: updated.name,
        lookups: 2,
        qualified: 1,
        notQualified: 0,
        escalated: 0,
      },
    ]);
    expect(JSON.stringify(report)).not.toMatch(/sessionId|contactId|customer/i);
  });

  it('retrieves only enabled campaigns inside their validity dates', async () => {
    const now = Date.parse('2026-10-24T12:00:00.000Z');
    const services = await testServices(() => now);
    const profile = await services.profiles.createProfile(profileInput);
    const campaigns = services.salesCampaigns;
    const add = (name: string, input: Record<string, unknown> = {}) =>
      campaigns.create(profile.id, {
        name,
        description: `${name} offer`,
        ...input,
      });

    await add('Current', { startsOn: '2026-10-01', endsOn: '2026-10-31' });
    await add('Paused', { active: false });
    await add('Expired', { endsOn: '2026-10-23' });
    await add('Future', { startsOn: '2026-10-25' });

    expect((await campaigns.searchForAgent(profile.id)).map(({ name }) => name)).toEqual([
      'Current',
    ]);
  });

  it('searches playbooks and falls back to the active catalog after a literal miss', async () => {
    const services = await testServices(() => Date.parse('2026-10-24T12:00:00.000Z'));
    const profile = await services.profiles.createProfile(profileInput);
    const campaigns = services.salesCampaigns;
    const lenses = await campaigns.create(profile.id, {
      name: 'DSP Lenses',
      description: 'Lenses and frames offer.',
      playbook: {
        objectionHandling: 'There is no message catalog; more than ten thousand models in store.',
      },
    });
    await campaigns.create(profile.id, {
      name: 'DSP Solidarity Exam',
      description: 'Exam offer with glasses purchase.',
    });
    await campaigns.create(profile.id, {
      name: 'Paused campaign',
      description: 'Not available.',
      active: false,
    });

    expect(await campaigns.searchForAgent(profile.id, 'message catalog')).toEqual([lenses]);
    expect(
      (await campaigns.searchForAgent(profile.id, 'unmatched search term')).map(({ name }) => name),
    ).toEqual(['DSP Lenses', 'DSP Solidarity Exam']);
  });
});
