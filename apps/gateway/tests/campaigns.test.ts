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
    });
    expect(await campaigns.list(profile.id)).toEqual([updated]);
    await campaigns.removeForAgent(profile.id, contactSessionId, updated.id);
    expect(await campaigns.list(profile.id)).toEqual([]);
  });
});
