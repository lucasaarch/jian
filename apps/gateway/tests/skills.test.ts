import { MAX_LIBRARY_SKILLS, type McpServer, mcpSchema, skillSchema } from '@jian/contracts';
import { describe, expect, it } from 'vitest';
import { githubMcpServer } from '../src/agent/github-mcp.js';
import { profileTools } from '../src/agent/tools.js';
import {
  availableSkills,
  builtinSkills,
  findSkill,
  NO_LIBRARY,
} from '../src/skills/builtin/index.js';
import { videoProductionFor } from '../src/skills/builtin/video-production.js';
import { parseSkillDocument } from '../src/skills/document.js';
import { Skills } from '../src/skills/service.js';
import { testServices } from './helpers/services.js';

const model = { provider: 'openai' as const, modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' };

const document = `---
name: deploy
description: Ship a release safely
user-invocable: true
allowed-tools:
  - Read
  - Bash(ls *)
---

Check the release notes, then run the pipeline.
`;

/** Serves the paths a test declares and answers 404 for everything else, like GitHub does. */
function repository(files: Record<string, string>) {
  const asked: string[] = [];

  const fetcher = (async (input: RequestInfo | URL) => {
    const url = String(input);

    asked.push(url);

    const body = Object.entries(files).find(([path]) => url.endsWith(path))?.[1];

    return body === undefined
      ? new Response('Not Found', { status: 404 })
      : new Response(body, { status: 200 });
  }) as typeof globalThis.fetch;

  return { fetcher, asked };
}

const written = (name: string, description = 'Written by hand') => ({
  name,
  description,
  instructions: 'Written by hand.',
});

describe('skill documents', () => {
  it('reads the open format and ignores the keys other runtimes add', () => {
    const skill = parseSkillDocument(document);

    expect(skill.name).toBe('deploy');
    expect(skill.description).toBe('Ship a release safely');
    expect(skill.instructions).toBe('Check the release notes, then run the pipeline.');
    expect(skill.instructions).not.toContain('allowed-tools');
  });

  it('refuses a document that would leave the agent with nothing to follow', () => {
    expect(() => parseSkillDocument('no frontmatter here')).toThrow();
    expect(() => parseSkillDocument('---\nname: x\n---\n\nBody.')).toThrow();
    expect(() => parseSkillDocument('---\nname: x\ndescription: d\n---\n\n')).toThrow();
  });
});

describe('importing a skill', () => {
  it('copies the instructions into the library and records where they came from', async () => {
    const services = await testServices();
    const { fetcher } = repository({ 'skills/deploy/SKILL.md': document });

    const [imported] = await new Skills(services.skillLibrary, fetcher).importSkill({
      url: 'https://github.com/acme/tools/tree/main/skills/deploy',
    });

    expect(imported?.instructions).toContain('run the pipeline');
    expect(imported?.origin?.ref).toBe('main');
    expect(imported?.origin?.url).toContain('github.com/acme/tools');
    expect(imported?.enabled).toBe(true);
    expect((await services.skillLibrary.list()).map((skill) => skill.name)).toEqual(['deploy']);
  });

  it('keeps what others wrote and replaces only the skill of the same name', async () => {
    const services = await testServices();
    const agent = await services.profiles.createProfile({
      name: 'Atlas',
      instructions: 'Help.',
      model,
    });
    await services.skillLibrary.create(written('notes'), agent.id);
    await services.skillLibrary.create(written('deploy', 'An older copy'), agent.id);
    const { fetcher } = repository({ 'skills/deploy/SKILL.md': document });

    const imported = await new Skills(services.skillLibrary, fetcher).importSkill({
      url: 'https://github.com/acme/tools/tree/main/skills/deploy',
    });
    const library = await services.skillLibrary.list();

    // Only what was imported is answered; the library still holds the rest.
    expect(imported.map((skill) => skill.name)).toEqual(['deploy']);
    expect(library).toHaveLength(2);
    expect(library.find((skill) => skill.name === 'notes')).toMatchObject({
      writtenBy: 'agent',
      authorProfileId: agent.id,
    });
    // An import is the owner's: the agent that wrote the older copy no longer owns the name.
    const deploy = library.find((skill) => skill.name === 'deploy');
    expect(deploy?.description).toBe('Ship a release safely');
    expect(deploy?.origin?.ref).toBe('main');
    expect(deploy?.writtenBy).toBeUndefined();
    expect(deploy?.authorProfileId).toBeUndefined();
  });

  it('refuses a host it cannot resolve, without touching the library', async () => {
    const services = await testServices();
    const { fetcher, asked } = repository({});
    const skills = new Skills(services.skillLibrary, fetcher);

    await expect(
      skills.importSkill({ url: 'https://gitlab.com/acme/tools' }),
    ).rejects.toMatchObject({ statusCode: 400 });

    expect(asked).toHaveLength(0);
    expect(await services.skillLibrary.list()).toHaveLength(0);
  });

  it('reports a rate limited host instead of leaving a half imported library', async () => {
    const services = await testServices();
    const fetcher = (async () => new Response('', { status: 403 })) as typeof globalThis.fetch;
    const skills = new Skills(services.skillLibrary, fetcher);

    await expect(
      skills.importSkill({ url: 'https://github.com/acme/tools' }),
    ).rejects.toMatchObject({ statusCode: 429 });

    expect(await services.skillLibrary.list()).toHaveLength(0);
  });

  it('refuses an import the library has no room for, and keeps none of it', async () => {
    const services = await testServices();

    for (let index = 0; index < MAX_LIBRARY_SKILLS; index++) {
      await services.skillLibrary.create(written(`held-${index}`));
    }

    const { fetcher } = repository({ 'skills/deploy/SKILL.md': document });

    await expect(
      new Skills(services.skillLibrary, fetcher).importSkill({
        url: 'https://github.com/acme/tools/tree/main/skills/deploy',
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(await services.skillLibrary.list()).toHaveLength(MAX_LIBRARY_SKILLS);
  });
});

describe('importing a folder of skills', () => {
  it.each(['skills', 'skills/.curated'])('imports a skill from the %s directory', async (path) => {
    const services = await testServices();
    const { fetcher } = repository({
      [`contents/${path}?ref=main`]: JSON.stringify([
        { name: 'deploy', type: 'dir' },
        { name: 'README.md', type: 'file' },
      ]),
      [`${path}/deploy/SKILL.md`]: document,
    });
    const imported = await new Skills(services.skillLibrary, fetcher).importSkill({
      url: `https://github.com/acme/tools/tree/main/${path}`,
    });

    expect(imported.map((skill) => skill.name)).toEqual(['deploy']);
    expect(imported[0]?.instructions).toBe('Check the release notes, then run the pipeline.');
  });

  it('imports a folder of skills without duplicating the skills path', async () => {
    const services = await testServices();
    const { fetcher } = repository({
      'contents/skills?ref=main': JSON.stringify([{ name: 'deploy', type: 'dir' }]),
      'skills/deploy/SKILL.md': document,
    });
    const imported = await new Skills(services.skillLibrary, fetcher).importSkill({
      url: 'https://github.com/acme/tools/tree/main/skills',
    });
    expect(imported.map((skill) => skill.name)).toEqual(['deploy']);
  });
});

describe('the skills every agent carries', () => {
  const names = (servers: McpServer[] = []) =>
    availableSkills(NO_LIBRARY, servers).map((skill) => skill.name);

  it('teaches web research, code and MCP only to a run that has those tools', () => {
    const docs = mcpSchema.parse({
      name: 'docs',
      transport: 'http',
      url: 'https://mcp.example.test/mcp',
    });

    // Shell, remote-control and web skills are always on; MCP follows the configured servers.
    for (const skill of [
      'web-research',
      'machine-tools',
      'remote-control',
      'coding-work',
      'ponytail',
      'ponytail-review',
    ]) {
      expect(names([])).toContain(skill);
      expect(names([docs])).toContain(skill);
    }
    for (const skill of ['mcp-servers', 'github-mcp']) {
      expect(names([])).not.toContain(skill);
      expect(names([docs])).toContain(skill);
    }

    expect(names([])).toEqual(
      expect.arrayContaining([
        'about-jian',
        'jian-configuration',
        'activity',
        'schedules',
        'media',
        'owner-and-contacts',
        'managing-yourself',
      ]),
    );
  });

  it('starts an installation without the opt-in skills, and turns one on for every agent', async () => {
    const services = await testServices();
    const offered = async () =>
      availableSkills(await services.skillLibrary.read(), []).map((skill) => skill.name);

    expect(await services.skillLibrary.list()).toEqual([]);
    expect(await offered()).not.toContain('discernment-nudge');

    await services.skillLibrary.setEnabled('discernment-nudge', { enabled: true });

    expect(await offered()).toContain('discernment-nudge');
  });

  it('teaches GitHub only to a run the integration attached its server to', () => {
    const attached = [githubMcpServer('github')];
    const configured = [{ ...githubMcpServer('mine'), auth: 'oauth' as const, headers: [] }];

    expect(findSkill(NO_LIBRARY, [], 'github')).toBeUndefined();
    expect(findSkill(NO_LIBRARY, configured, 'github')).toBeUndefined();
    expect(findSkill(NO_LIBRARY, attached, 'github')?.instructions).toContain('search_mcp_tools');
  });

  it('keeps every built-in skill within what a skill may be', () => {
    for (const skill of builtinSkills([
      {
        name: 'x',
        transport: 'http',
        url: 'https://x.test',
        auth: 'none',
        headers: [],
        args: [],
        env: [],
        disabledTools: [],
      },
    ])) {
      expect(() => skillSchema.parse(skill), skill.name).not.toThrow();
    }
    // The longest form a run may be told, on a machine without file tools there.
    expect(() => skillSchema.parse(videoProductionFor({ files: false }))).not.toThrow();
  });

  it('keeps product identity separate from operational guidance', () => {
    const skills = builtinSkills([]);
    const about = skills.find((skill) => skill.name === 'about-jian');
    const activity = skills.find((skill) => skill.name === 'activity');
    const configuration = skills.find((skill) => skill.name === 'jian-configuration');

    expect(about?.instructions).toContain('created by Lucas Larangeira');
    expect(about?.instructions).not.toMatch(
      /read_activity_stats|ask_jev|load_tools|JIAN_TIME_ZONE/,
    );
    expect(activity?.instructions).toContain('read_activity_stats');
    expect(activity?.instructions).toContain('read_usage_runs');
    expect(activity?.instructions).toContain('not money spent');
    expect(configuration?.instructions).toContain('JIAN_TIME_ZONE');
  });

  it('always explains workspace shell and Remote Control (allowShell is deprecated)', () => {
    expect(names()).toContain('machine-tools');
    expect(names()).toContain('remote-control');
  });

  it('loads a built-in body through the same tool as a library one', async () => {
    const services = await testServices();
    const profile = await services.profiles.createProfile({
      name: 'Atlas',
      instructions: 'Help.',
      model,
    });
    await services.skillLibrary.create({
      name: 'house-style',
      description: 'Owner rules',
      instructions: 'Lead with the answer.',
    });
    const session = await services.sessions.createSession(profile.id, { title: 'Test' });
    const run = await services.runs.submit(profile.id, session.id, {
      text: 'Hi',
      requestKey: 'builtin',
    });
    const load = profileTools({ ...services, store: services.store }, run).load_skill;

    if (!load?.execute) {
      throw new Error('load_skill is unavailable');
    }

    const call = { toolCallId: 'test', messages: [], context: {} };
    const read = async (name: string) =>
      (await load.execute?.({ name } as never, call)) as { instructions: string };

    expect((await read('memory-keeping')).instructions).toContain('expectedVersion');
    expect((await read('house-style')).instructions).toBe('Lead with the answer.');
  });

  it('tells a conversation on a machine to make a video there, with the tools that reach it', async () => {
    const services = await testServices();
    const profile = await services.profiles.createProfile({
      name: 'Atlas',
      instructions: 'Help.',
      model,
    });
    // A conversation each: one that loaded a skill already is answered without it.
    const read = async (machine?: string) => {
      const session = await services.sessions.createSession(profile.id, { title: 'Ad' });
      const run = await services.runs.submit(profile.id, session.id, {
        text: 'Make the ad',
        requestKey: 'video',
      });
      const load = profileTools(
        { ...services, store: services.store },
        run,
        undefined,
        machine,
      ).load_skill;

      if (!load?.execute) {
        throw new Error('load_skill is unavailable');
      }

      const call = { toolCallId: 'test', messages: [], context: {} };
      const loaded = await load.execute({ name: 'video-production' } as never, call);
      return (loaded as { instructions: string }).instructions;
    };

    expect(await read()).toContain('`run_command`');
    // A machine's conversation has neither the gateway's shell nor file tools on that machine.
    const there = await read('machine-1');
    expect(there).toContain('`run_remote_command`');
    expect(there).toContain('`push_remote_file`');
    expect(there).not.toMatch(/`run_command`|`write_file`/);
  });

  it('lets the owner switch one off for every agent, and an import replace one', async () => {
    const services = await testServices();
    const offered = async () =>
      availableSkills(await services.skillLibrary.read(), []).map((skill) => skill.name);

    await services.skillLibrary.setEnabled('channel-replies', { enabled: false });

    expect(await offered()).not.toContain('channel-replies');
    // Switching one off leaves what was already off as it was.
    expect(await offered()).not.toContain('discernment-nudge');

    await services.skillLibrary.addImported([
      { name: 'memory-keeping', description: 'Mine', instructions: 'Remember nothing.' },
    ]);

    const library = await services.skillLibrary.read();

    expect(findSkill(library, [], 'memory-keeping')?.instructions).toBe('Remember nothing.');
    expect(availableSkills(library, []).filter((s) => s.name === 'memory-keeping')).toHaveLength(1);
  });

  it('offers a library skill to every agent until the owner switches it off', async () => {
    const services = await testServices();
    const offered = async () =>
      availableSkills(await services.skillLibrary.read(), []).map((skill) => skill.name);

    await services.skillLibrary.create(written('house-style'));
    expect(await offered()).toContain('house-style');

    await services.skillLibrary.setEnabled('house-style', { enabled: false });
    expect(await offered()).not.toContain('house-style');
    expect((await services.skillLibrary.list())[0]).toMatchObject({
      name: 'house-style',
      enabled: false,
    });

    // Removed and written again, it is a new skill: the old switch does not follow the name.
    await services.skillLibrary.remove('house-style');
    await services.skillLibrary.create(written('house-style'));
    expect(await offered()).toContain('house-style');
  });
});
