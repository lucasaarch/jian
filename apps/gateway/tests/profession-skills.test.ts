import { randomUUID } from 'node:crypto';
import {
  type ProfessionAuthority,
  type Profile,
  profileRecordSchema,
  type Run,
} from '@jian/contracts';
import { describe, expect, it, vi } from 'vitest';
import { buildContext } from '../src/context/build.js';
import { Contexts } from '../src/context/service.js';
import type { Judge } from '../src/decisions/service.js';
import { profileAuthority } from '../src/professions/effective.js';
import {
  availableSkills,
  builtinSkillNames,
  builtinSkills,
  findSkill,
} from '../src/skills/builtin/index.js';
import { testServices } from './helpers/services.js';

const now = '2026-10-24T00:00:00.000Z';
function profile(professionId: Profile['professionId'] = 'developer'): Profile {
  return profileRecordSchema.parse({
    id: randomUUID(),
    version: 1,
    createdAt: now,
    updatedAt: now,
    name: 'Test',
    instructions: 'Help.',
    professionId,
    allowSelfManagement: true,
    allowWebSearch: true,
    reachableByAgents: true,
    disabledSkills: [],
    mcpServers: [{ name: 'business', transport: 'http', url: 'https://example.test/mcp' }],
  });
}
function ceiling(current: Profile, capabilities: ProfessionAuthority['capabilities']) {
  const authority = profileAuthority(current);
  if (!authority) throw new Error('Expected classified profile');
  return { ...authority, capabilities };
}
function run(current: Profile, authority?: ProfessionAuthority): Run {
  return {
    id: randomUUID(),
    profileId: current.id,
    sessionId: randomUUID(),
    profile: current,
    requestKey: 'test',
    input: 'Help',
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    ...(authority ? { authority } : {}),
  };
}
const sources = { memories: [], activities: [], history: [], timeZone: 'UTC' };
const names = (skills: ReturnType<typeof builtinSkills>) => skills.map((skill) => skill.name);
const restricted = [
  'machine-tools',
  'coding-work',
  'remote-control',
  'ssh-keys',
  'managing-yourself',
  'subscriptions',
  'long-running-work',
  'ponytail',
  'ponytail-review',
  'ponytail-audit',
  'ponytail-debt',
  'ponytail-gain',
  'ponytail-help',
];

describe('profession skill surfaces', () => {
  it('filters both builtin discovery and body lookup for Attendant despite permissive switches', () => {
    const current = profile('attendant');
    const offered = names(availableSkills(current));
    expect(offered).toEqual(
      expect.arrayContaining(['about-jian', 'conversations', 'media', 'mcp-servers']),
    );
    for (const name of [...restricted, 'web-research']) {
      expect(names(builtinSkills(current))).not.toContain(name);
      expect(offered).not.toContain(name);
      expect(findSkill(current, name)).toBeUndefined();
    }
  });

  it('applies the same name classification to custom replacements but not unrelated instructions', () => {
    const current = profile('attendant');
    current.skills = [...restricted, 'web-research', 'house-style', 'media'].map((name) => ({
      name,
      description: 'Custom replacement',
      instructions: 'Owner text is not authority.',
    }));
    for (const name of [...restricted, 'web-research']) {
      expect(findSkill(current, name)).toBeUndefined();
    }
    expect(findSkill(current, 'house-style')?.instructions).toBe('Owner text is not authority.');
    expect(findSkill(current, 'media')?.description).toBe('Custom replacement');
    expect(availableSkills(current).filter((skill) => skill.name === 'media')).toHaveLength(1);
  });

  it('classifies every builtin and keeps the switches-only legacy API', () => {
    const current = profile();
    const nonProfessionSkills = [...builtinSkillNames].filter((name) => name !== 'sales-attendant');
    expect(names(builtinSkills(current)).sort()).toEqual(nonProfessionSkills.sort());
    expect(names(builtinSkills(profile('attendant')))).toContain('sales-attendant');
    const { allowSelfManagement, allowWebSearch, mcpServers, reachableByAgents } = current;
    expect(
      names(
        builtinSkills({ allowSelfManagement, allowWebSearch, mcpServers, reachableByAgents }),
      ).sort(),
    ).toEqual(nonProfessionSkills.sort());
  });

  it('keeps builtins fixed for professions while legacy profiles retain their old switches', () => {
    const developer = profile('developer');
    expect(names(availableSkills(developer))).toEqual(
      expect.arrayContaining([...restricted, 'web-research', 'github-mcp']),
    );
    developer.disabledSkills = ['coding-work'];
    expect(findSkill(developer, 'coding-work')).toBeDefined();
    developer.skills = [{ name: 'coding-work', description: 'Custom', instructions: 'Override.' }];
    expect(findSkill(developer, 'coding-work')?.instructions).toBe('Override.');
    developer.disabledSkills = ['coding-work', 'web-research', 'managing-yourself'];
    developer.allowWebSearch = false;
    developer.allowSelfManagement = false;
    expect(findSkill(developer, 'web-research')).toBeDefined();
    expect(findSkill(developer, 'managing-yourself')).toBeDefined();

    const legacy = profile(null);
    legacy.allowWebSearch = false;
    expect(findSkill(legacy, 'web-research')).toBeUndefined();
  });

  it('intersects inherited authority for listing, custom bodies and optional web access', () => {
    const current = profile();
    const authority = ceiling(current, ['skills.read', 'conversation.control']);
    current.skills = [{ name: 'machine-tools', description: 'Custom', instructions: 'No bypass.' }];
    expect(findSkill(current, 'machine-tools', authority)).toBeUndefined();
    expect(findSkill(current, 'web-research', authority)).toBeUndefined();
    expect(findSkill(current, 'web-research')).toBeDefined();
    expect(
      findSkill(current, 'web-research', ceiling(current, ['skills.read', 'web.browse'])),
    ).toBeDefined();
    expect(availableSkills(current, ceiling(current, []))).toEqual([]);
    expect(builtinSkills(current, ceiling(current, []))).toEqual([]);
  });

  it('fails closed for invalid professions and malformed inherited authority', () => {
    const current = profile();
    expect(() =>
      availableSkills({ ...current, professionId: 'unknown' } as unknown as Profile),
    ).toThrow();
    expect(() =>
      availableSkills(current, { ...ceiling(current, []), policyVersion: 999 }),
    ).toThrow();
    expect(() => availableSkills(profile(null), ceiling(current, []))).toThrow();
  });

  it('omits unauthorized context promises, catalog entries and rejected skill hints', () => {
    const current = profile('attendant');
    const { system } = buildContext(run(current), { ...sources, suggestedSkill: 'coding-work' });
    expect(system).not.toContain('You can run commands');
    expect(system).not.toContain('Remote Control machines');
    expect(system).not.toContain('You can search the web');
    expect(system).not.toContain('coding-work');
    expect(system).toContain('"name":"media"');
    expect(system).toContain('Profession-specific guidance (always apply):');
    expect(system).toContain('Before recommending an offer, use list_sales_campaigns');
    expect(system).toContain('no active campaign is available');
    const developer = profile();
    const normal = buildContext(run(developer), sources).system;
    expect(normal).not.toContain('Profession-specific guidance (always apply):');
    expect(normal).not.toContain('Before recommending an offer, use list_sales_campaigns');
    expect(normal).toContain('You can run commands');
    expect(normal).toContain('Remote Control machines');
    expect(normal).toContain('You can search the web');
    const inherited = buildContext(
      run(developer, ceiling(developer, ['skills.read'])),
      sources,
    ).system;
    expect(inherited).not.toContain('You can run commands');
    expect(inherited).not.toContain('Remote Control machines');
    expect(inherited).not.toContain('You can search the web');
  });

  it('only offers effective skills to the context judge', async () => {
    const services = await testServices();
    const stored = await services.profiles.createProfile({
      name: 'Context fixture',
      instructions: 'Help.',
    });
    const session = await services.sessions.createSession(stored.id, {});
    const current = { ...profile(), id: stored.id };
    const judge = vi.fn<Judge>(async () => undefined);
    const contexts = new Contexts(
      services.store,
      services.runs,
      services.sessions,
      undefined,
      judge,
    );
    const testRun = { ...run(current, ceiling(current, ['skills.read'])), sessionId: session.id };
    await contexts.context(testRun);
    const questions = judge.mock.calls[0]?.[1];
    expect(questions?.skill?.type).toBe('choice');
    if (questions?.skill?.type !== 'choice') throw new Error('Expected skill choice');
    expect(Object.keys(questions.skill.criteria)).toContain('about-jian');
    for (const name of [...restricted, 'web-research', 'mcp-servers']) {
      expect(Object.keys(questions.skill.criteria)).not.toContain(name);
    }
  });
});
