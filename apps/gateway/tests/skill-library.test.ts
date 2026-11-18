import { readFile } from 'node:fs/promises';
import { MAX_LIBRARY_SKILLS, OPT_IN_SKILLS, type Run } from '@jian/contracts';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { availableSkills } from '../src/skills/builtin/index.js';
import { Skills } from '../src/skills/service.js';
import { skillTools } from '../src/skills/tools.js';
import { profileRevisions } from '../src/storage/schema.js';
import { testServices } from './helpers/services.js';

const model = { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' } as const;
const token = 'test-token-that-is-at-least-32-characters';
const headers = { authorization: `Bearer ${token}` };

const skill = (name: string, instructions = 'Lead with the answer.') => ({
  name,
  description: `Use for ${name}`,
  instructions,
});

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe('moving each agent’s skills into one library', () => {
  const long = 'a'.repeat(64);
  const origin = (importedAt: string) => ({
    url: 'https://github.com/acme/tools/tree/main/skills/deploy',
    ref: 'main',
    importedAt,
  });

  /**
   * The gateway as it was before the library: a list of skills and of switched-off built-in
   * names on each agent, each given by `agents` from the newest edited to the oldest.
   */
  async function migrated(agents: Array<{ skills: unknown[]; disabled: string[] }>) {
    const services = await testServices();
    const db = services.store.db;
    const profiles = [];

    for (const [index] of agents.entries()) {
      profiles.push(
        await services.profiles.createProfile({
          name: `Agent ${index}`,
          instructions: 'Help.',
          model,
        }),
      );
    }

    await db.execute(sql`DROP TABLE skills`);
    await db.execute(sql`ALTER TABLE profiles ADD COLUMN skills jsonb NOT NULL DEFAULT '[]'`);
    await db.execute(
      sql`ALTER TABLE profiles ADD COLUMN disabled_skills jsonb NOT NULL DEFAULT '[]'`,
    );
    await db.execute(sql`UPDATE profile_revisions
      SET document = document || '{"skills": [], "disabledSkills": ["caveman"]}'::jsonb`);

    for (const [index, agent] of agents.entries()) {
      await db.execute(sql`UPDATE profiles SET
        updated_at = ${`2026-10-${String(25 - index).padStart(2, '0')}T10:00:00Z`},
        skills = ${JSON.stringify(agent.skills)}::jsonb,
        disabled_skills = ${JSON.stringify(agent.disabled)}::jsonb
        WHERE id = ${profiles[index]?.id}`);
    }

    const migration = await readFile(
      new URL('../migrations/0106_shared-skills.sql', import.meta.url),
      'utf8',
    );
    for (const statement of migration.split('--> statement-breakpoint')) {
      await db.execute(sql.raw(statement));
    }

    return { services, profiles: profiles.map((profile) => profile.id) };
  }

  const agents = () => [
    {
      skills: [
        { ...skill('checklist'), writtenBy: 'agent' },
        { ...skill('report', 'The newest way.'), writtenBy: 'agent' },
        { ...skill('deploy'), origin: origin('2026-10-02T10:00:00.000Z') },
        skill(long, 'The newest way.'),
      ],
      disabled: ['discernment-nudge', 'channel-replies', 'deploy'],
    },
    {
      skills: [
        { ...skill('checklist'), writtenBy: 'agent' },
        { ...skill('report', 'An older way.'), writtenBy: 'agent' },
        { ...skill('deploy'), origin: origin('2026-09-01T10:00:00.000Z') },
        skill('house-style'),
        skill(long, 'An older way.'),
      ],
      disabled: ['discernment-nudge', 'channel-replies', 'deploy', 'caveman'],
    },
    {
      skills: [{ ...skill('report', 'The oldest way.'), writtenBy: 'agent' }, skill('house-style')],
      disabled: ['channel-replies', 'deploy', 'discernment-nudge'],
    },
  ];

  it('keeps one of each skill, both of two that differ, and who wrote them', async () => {
    const { services, profiles } = await migrated(agents());
    const [newest, older, oldest] = profiles;
    const library = await services.skillLibrary.list();
    const held = Object.fromEntries(library.map((item) => [item.name, item]));

    expect(Object.keys(held).sort()).toEqual(
      [
        'checklist',
        'deploy',
        'house-style',
        'report',
        'report_2',
        'report_3',
        long,
        `${'a'.repeat(62)}_2`,
      ].sort(),
    );

    // The same skill on two agents is one, and the newest of them is its author.
    expect(held.checklist).toMatchObject({ writtenBy: 'agent', authorProfileId: newest });
    // Three that differ all stay: the newest agent's keeps the name.
    expect(held.report).toMatchObject({ instructions: 'The newest way.', authorProfileId: newest });
    expect(held.report_2).toMatchObject({ instructions: 'An older way.', authorProfileId: older });
    expect(held.report_3).toMatchObject({
      instructions: 'The oldest way.',
      authorProfileId: oldest,
    });
    // A renamed skill still fits what a name may be.
    expect(held[`${'a'.repeat(62)}_2`]?.instructions).toBe('An older way.');

    // Only an agent's own skill has an author: an import and the owner's writing have none.
    expect(held.deploy?.origin?.importedAt).toBe('2026-10-02T10:00:00.000Z');
    expect(held.deploy).not.toHaveProperty('authorProfileId');
    expect(held.deploy).not.toHaveProperty('writtenBy');
    expect(held['house-style']).not.toHaveProperty('authorProfileId');
    expect(held['house-style']).not.toHaveProperty('writtenBy');
    expect(held['house-style']).not.toHaveProperty('origin');
  });

  it('leaves off only what every agent had switched off', async () => {
    const { services, profiles } = await migrated(agents());
    const library = await services.skillLibrary.read();

    // `caveman` was on for two agents; `deploy` is a library skill now, which was never off.
    expect(library.disabled).toEqual(['channel-replies', 'discernment-nudge']);
    expect(library.skills.every((item) => item.enabled)).toBe(true);
    expect(availableSkills(library, []).map((item) => item.name)).toEqual(
      expect.arrayContaining(['caveman', 'deploy', 'report_2']),
    );

    // The agents read as before, with nothing of the skills left on them or their history.
    for (const id of profiles) {
      const profile = await services.profiles.profile(id);

      expect(profile).not.toHaveProperty('skills');
      expect(profile).not.toHaveProperty('disabledSkills');
    }
    const revisions = await services.store.db
      .select({ document: profileRevisions.document })
      .from(profileRevisions);

    expect(revisions).toHaveLength(profiles.length);
    for (const { document } of revisions) {
      expect(document).not.toHaveProperty('skills');
      expect(document).not.toHaveProperty('disabledSkills');
      expect(document.name).toMatch(/^Agent \d$/);
    }
  });

  it('switches everything on when the agents shared nothing switched off', async () => {
    const { services } = await migrated([
      { skills: [], disabled: ['discernment-nudge'] },
      { skills: [], disabled: [] },
    ]);

    expect((await services.skillLibrary.read()).disabled).toEqual([]);
  });

  it('starts an installation with no agent from the default', async () => {
    const { services } = await migrated([]);

    expect(await services.skillLibrary.read()).toEqual({
      skills: [],
      disabled: [...OPT_IN_SKILLS],
    });
  });

  it('keeps a skill when the agent that wrote it is deleted, without its author', async () => {
    const services = await testServices();
    const agent = await services.profiles.createProfile({
      name: 'Atlas',
      instructions: 'Help.',
      model,
    });
    await services.skillLibrary.create(skill('report'), agent.id);

    await services.profiles.deleteProfile(agent.id);

    const [kept] = await services.skillLibrary.list();
    expect(kept).toMatchObject({ name: 'report', writtenBy: 'agent' });
    expect(kept).not.toHaveProperty('authorProfileId');
  });
});

describe('the owner’s skill routes', () => {
  async function setup(files: Record<string, string> = {}) {
    const services = await testServices();
    const fetcher = (async (input: RequestInfo | URL) => {
      const body = Object.entries(files).find(([path]) => String(input).endsWith(path))?.[1];

      return body === undefined
        ? new Response('Not Found', { status: 404 })
        : new Response(body, { status: 200 });
    }) as typeof globalThis.fetch;
    const app = createApp({
      ...services,
      skills: new Skills(services.skillLibrary, fetcher),
      token,
      logger: false,
    });

    apps.push(app);

    return { app, services };
  }

  it('refuses every route to a caller without the owner’s token', async () => {
    const { app, services } = await setup();
    await services.skillLibrary.create(skill('house-style'));

    for (const [method, url, payload] of [
      ['GET', '/v1/skills'],
      ['GET', '/v1/built-in-skills'],
      ['POST', '/v1/skills', skill('other')],
      ['POST', '/v1/skills/import', { url: 'https://github.com/acme/tools' }],
      ['PATCH', '/v1/skills/house-style', { description: 'Changed' }],
      ['PUT', '/v1/skills/house-style/enabled', { enabled: false }],
      ['DELETE', '/v1/skills/house-style'],
    ] as const) {
      const response = await app.inject({ method, url, ...(payload ? { payload } : {}) });

      expect(response.statusCode, `${method} ${url}`).toBe(401);
    }

    expect(await services.skillLibrary.list()).toMatchObject([
      { name: 'house-style', description: 'Use for house-style', enabled: true },
    ]);
  });

  it('writes, edits, lists and removes a skill of the owner', async () => {
    const { app, services } = await setup();
    const agent = await services.profiles.createProfile({
      name: 'Atlas',
      instructions: 'Help.',
      model,
    });
    await services.skillLibrary.create(skill('report'), agent.id);

    const created = await app.inject({
      method: 'POST',
      url: '/v1/skills',
      headers,
      payload: skill('house-style'),
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ name: 'house-style', enabled: true });
    expect(created.json()).not.toHaveProperty('writtenBy');
    expect(created.json()).not.toHaveProperty('authorProfileId');

    // A name is one skill, and a built-in's name is the gateway's.
    for (const name of ['house-style', 'memory-keeping']) {
      const again = await app.inject({
        method: 'POST',
        url: '/v1/skills',
        headers,
        payload: skill(name),
      });

      expect(again.statusCode, name).toBe(409);
    }
    // The author is not the caller's to say.
    const forged = await app.inject({
      method: 'POST',
      url: '/v1/skills',
      headers,
      payload: { ...skill('forged'), writtenBy: 'agent', authorProfileId: agent.id },
    });
    expect(forged.statusCode).toBe(400);

    // The owner edits any of them, an agent's included, and it stays that agent's.
    const edited = await app.inject({
      method: 'PATCH',
      url: '/v1/skills/report',
      headers,
      payload: { instructions: 'Numbers first.' },
    });

    expect(edited.statusCode).toBe(200);
    expect(edited.json()).toMatchObject({
      name: 'report',
      description: 'Use for report',
      instructions: 'Numbers first.',
      writtenBy: 'agent',
      authorProfileId: agent.id,
    });

    const listed = await app.inject({ method: 'GET', url: '/v1/skills', headers });

    expect((listed.json() as Array<{ name: string }>).map((item) => item.name)).toEqual([
      'report',
      'house-style',
    ]);

    for (const [method, url, payload] of [
      ['PATCH', '/v1/skills/missing', { description: 'Changed' }],
      ['PATCH', '/v1/skills/memory-keeping', { description: 'Changed' }],
      ['DELETE', '/v1/skills/memory-keeping', undefined],
    ] as const) {
      const response = await app.inject({ method, url, headers, ...(payload ? { payload } : {}) });

      expect(response.statusCode, `${method} ${url}`).toBe(404);
    }

    const removed = await app.inject({ method: 'DELETE', url: '/v1/skills/report', headers });

    expect(removed.statusCode).toBe(204);
    expect((await services.skillLibrary.list()).map((item) => item.name)).toEqual(['house-style']);
  });

  it('refuses a skill past what the library holds', async () => {
    const { app, services } = await setup();

    for (let index = 0; index < MAX_LIBRARY_SKILLS; index++) {
      await services.skillLibrary.create(skill(`held-${index}`));
    }

    const response = await app.inject({
      method: 'POST',
      url: '/v1/skills',
      headers,
      payload: skill('one-more'),
    });

    expect(response.statusCode).toBe(409);
    expect(await services.skillLibrary.list()).toHaveLength(MAX_LIBRARY_SKILLS);
  });

  it('switches a built-in or a library skill off and on for every agent', async () => {
    const { app, services } = await setup();
    await services.skillLibrary.create(skill('house-style'));
    const set = (name: string, enabled: boolean) =>
      app.inject({
        method: 'PUT',
        url: `/v1/skills/${name}/enabled`,
        headers,
        payload: { enabled },
      });
    const builtin = async (name: string) =>
      (
        (await app.inject({ method: 'GET', url: '/v1/built-in-skills', headers })).json() as Array<{
          name: string;
          enabled: boolean;
          instructions: string;
        }>
      ).find((item) => item.name === name);
    const offered = async () =>
      availableSkills(await services.skillLibrary.read(), []).map((item) => item.name);

    expect((await builtin('channel-replies'))?.enabled).toBe(true);
    expect((await builtin('discernment-nudge'))?.enabled).toBe(false);

    const off = await set('channel-replies', false);

    expect(off.statusCode).toBe(200);
    expect(off.json()).toEqual({ name: 'channel-replies', enabled: false });
    expect(await builtin('channel-replies')).toMatchObject({ enabled: false });
    expect((await builtin('channel-replies'))?.instructions).not.toBe('');
    expect((await set('house-style', false)).statusCode).toBe(200);
    expect(await offered()).not.toContain('channel-replies');
    expect(await offered()).not.toContain('house-style');

    const listed = await app.inject({ method: 'GET', url: '/v1/skills', headers });

    expect(listed.json()).toMatchObject([{ name: 'house-style', enabled: false }]);

    expect((await set('channel-replies', true)).json()).toEqual({
      name: 'channel-replies',
      enabled: true,
    });
    expect((await set('discernment-nudge', true)).statusCode).toBe(200);
    expect(await offered()).toEqual(
      expect.arrayContaining(['channel-replies', 'discernment-nudge']),
    );
    expect((await set('missing', false)).statusCode).toBe(404);

    // Removed, a switched-off skill leaves the list: a new one of that name starts on.
    await app.inject({ method: 'DELETE', url: '/v1/skills/house-style', headers });
    expect((await services.skillLibrary.read()).disabled).not.toContain('house-style');
  });

  it('imports from GitHub into the library and answers what it imported', async () => {
    const { app, services } = await setup({
      'skills/deploy/SKILL.md':
        '---\nname: deploy\ndescription: Ship a release safely\n---\n\nRun the pipeline.\n',
    });
    await services.skillLibrary.create(skill('house-style'));

    const response = await app.inject({
      method: 'POST',
      url: '/v1/skills/import',
      headers,
      payload: { url: 'https://github.com/acme/tools/tree/main/skills/deploy' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject([
      {
        name: 'deploy',
        instructions: 'Run the pipeline.',
        enabled: true,
        origin: { ref: 'main' },
      },
    ]);
    expect((await services.skillLibrary.list()).map((item) => item.name).sort()).toEqual([
      'deploy',
      'house-style',
    ]);
  });
});

describe('the skills an agent writes', () => {
  type Tool = { execute: (input: Record<string, unknown>) => Promise<Record<string, unknown>> };

  async function setup() {
    const services = await testServices();
    const create = (name: string) =>
      services.profiles.createProfile({ name, instructions: 'Help.', model });
    const [atlas, nova] = [await create('Atlas'), await create('Nova')];
    const tools = (profileId: string) =>
      skillTools(services.skillLibrary, { profileId } as Run) as unknown as Record<
        'create_skill' | 'update_skill' | 'delete_skill',
        Tool
      >;

    return { services, atlas: tools(atlas.id), nova: tools(nova.id), ids: [atlas.id, nova.id] };
  }

  it('shares what one agent writes with every agent, under its author', async () => {
    const { services, atlas, ids } = await setup();

    const result = await atlas.create_skill.execute(skill('report'));

    expect(result).toEqual({
      created: 'report',
      yours: [{ name: 'report', description: 'Use for report' }],
    });
    expect(await services.skillLibrary.list()).toMatchObject([
      { name: 'report', writtenBy: 'agent', authorProfileId: ids[0], enabled: true },
    ]);
    // The library is not read through a profile: whoever runs is offered it.
    expect(
      availableSkills(await services.skillLibrary.read(), []).map((item) => item.name),
    ).toContain('report');

    await atlas.update_skill.execute({ name: 'report', instructions: 'Numbers first.' });
    expect((await services.skillLibrary.list())[0]?.instructions).toBe('Numbers first.');

    await atlas.delete_skill.execute({ name: 'report' });
    expect(await services.skillLibrary.list()).toEqual([]);
  });

  it('changes only its own: not another agent’s, the owner’s or an imported one', async () => {
    const { services, atlas, nova } = await setup();
    await atlas.create_skill.execute(skill('report'));
    await services.skillLibrary.create(skill('house-style'));
    await services.skillLibrary.addImported([
      {
        ...skill('deploy'),
        origin: { url: 'https://github.com/acme/tools', importedAt: '2026-10-02T10:00:00.000Z' },
      },
    ]);
    const before = await services.skillLibrary.list();

    for (const [name, whose] of [
      ['report', 'written by another agent; ask the owner'],
      ['house-style', 'written by the owner'],
      ['deploy', 'imported by the owner'],
    ] as const) {
      for (const attempt of [
        () => nova.update_skill.execute({ name, instructions: 'Mine now.' }),
        () => nova.delete_skill.execute({ name }),
      ]) {
        await expect(attempt(), name).rejects.toMatchObject({
          statusCode: 403,
          message: expect.stringContaining(whose),
        });
      }
    }

    expect(await services.skillLibrary.list()).toEqual(before);
    // Nor does it show as one of the caller's.
    expect((await nova.create_skill.execute(skill('notes'))).yours).toEqual([
      { name: 'notes', description: 'Use for notes' },
    ]);
  });

  it('refuses a taken name, a built-in one and a skill past the cap', async () => {
    const { services, atlas, nova } = await setup();
    await atlas.create_skill.execute(skill('report'));

    await expect(nova.create_skill.execute(skill('report'))).rejects.toMatchObject({
      statusCode: 409,
    });
    await expect(nova.create_skill.execute(skill('memory-keeping'))).rejects.toMatchObject({
      statusCode: 409,
    });
    await expect(
      nova.update_skill.execute({ name: 'missing', description: 'Changed' }),
    ).rejects.toMatchObject({ statusCode: 404 });

    for (let index = 1; index < MAX_LIBRARY_SKILLS; index++) {
      await services.skillLibrary.create(skill(`held-${index}`));
    }

    await expect(nova.create_skill.execute(skill('one-more'))).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining(String(MAX_LIBRARY_SKILLS)),
    });
    expect(await services.skillLibrary.list()).toHaveLength(MAX_LIBRARY_SKILLS);
  });
});
