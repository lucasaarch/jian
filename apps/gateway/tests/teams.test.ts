import { describe, expect, it } from 'vitest';
import { testServices } from './helpers/services.js';

describe('global teams', () => {
  it('stores multiple memberships and removes only the deleted team', async () => {
    const services = await testServices();
    const first = await services.profiles.createProfile({ name: 'First', instructions: 'Help.' });
    const second = await services.profiles.createProfile({ name: 'Second', instructions: 'Help.' });
    const third = await services.profiles.createProfile({ name: 'Third', instructions: 'Help.' });

    const alpha = await services.teams.create({
      name: 'Alpha',
      description: 'One project',
      profileIds: [first.id, second.id],
    });
    const beta = await services.teams.create({
      name: 'Beta',
      description: '',
      profileIds: [first.id, third.id],
    });

    const listed = await services.teams.list();
    expect(listed.map((team) => team.name).sort()).toEqual(['Alpha', 'Beta']);
    expect(listed.find((team) => team.id === alpha.id)?.profileIds.sort()).toEqual(
      [first.id, second.id].sort(),
    );
    expect(listed.find((team) => team.id === beta.id)?.profileIds.sort()).toEqual(
      [first.id, third.id].sort(),
    );

    await services.teams.remove(alpha.id);
    const remaining = await services.teams.list();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({ id: beta.id, name: 'Beta' });
    expect(remaining[0]?.profileIds.sort()).toEqual([first.id, third.id].sort());
  });

  it('rejects membership for missing profiles without creating a partial team', async () => {
    const services = await testServices();

    await expect(
      services.teams.create({
        name: 'Invalid',
        description: '',
        profileIds: ['00000000-0000-0000-0000-000000000000'],
      }),
    ).rejects.toThrow(/profiles do not exist/);
    expect(await services.teams.list()).toEqual([]);
  });
});
