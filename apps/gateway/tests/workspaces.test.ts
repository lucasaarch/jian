import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Session } from '@jian/contracts';
import { eq } from 'drizzle-orm';
import { afterEach, expect, it } from 'vitest';
import { AgentRuntime } from '../src/agent/runtime.js';
import { sessions, workspaceSnapshots } from '../src/storage/schema.js';
import {
  digest,
  INSTRUCTIONS_CHARS,
  parseRemote,
  readLocal,
  remoteCommand,
} from '../src/workspaces/read.js';
import { Workspaces } from '../src/workspaces/service.js';
import { mockModel } from './helpers/model.js';
import { testServices } from './helpers/services.js';

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 10, text: 10, reasoning: 0 },
};
const answer = (text: string) => ({
  content: [{ type: 'text' as const, text }],
  finishReason: { unified: 'stop' as const, raw: 'stop' },
  usage,
  warnings: [],
});

const sh = promisify(execFile);
const folders: string[] = [];
afterEach(async () => {
  await Promise.all(
    folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })),
  );
});

/** A repository-shaped folder with `files`, by path relative to it. */
async function folder(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'jian-workspace-'));
  folders.push(root);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), text);
  }
  return root;
}

const skill = (name: string, description = `Does ${name}`) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\nHow to ${name}.`;

it('prefers AGENTS.md, and reads CLAUDE.md where there is none', async () => {
  const both = await folder({ 'AGENTS.md': 'Use pnpm.', 'CLAUDE.md': 'Use npm.' });
  const claude = await folder({ 'CLAUDE.md': 'Use yarn.' });

  expect(digest((await readLocal(both)) ?? { files: [], nested: [] }).instructions).toEqual({
    file: 'AGENTS.md',
    text: 'Use pnpm.',
    cut: false,
  });
  expect(digest((await readLocal(claude)) ?? { files: [], nested: [] }).instructions?.file).toBe(
    'CLAUDE.md',
  );
});

it('offers the skills of both folders once each, and only real ones', async () => {
  const root = await folder({
    '.agents/skills/release/SKILL.md': skill('release'),
    '.claude/skills/release/SKILL.md': skill('release', 'The other copy'),
    '.claude/skills/review/SKILL.md': skill('review'),
    '.claude/skills/broken/SKILL.md': 'no frontmatter here',
  });

  const { skills } = digest((await readLocal(root)) ?? { files: [], nested: [] });

  expect(skills.map((item) => [item.name, item.description])).toEqual([
    ['release', 'Does release'],
    ['review', 'Does review'],
  ]);
});

it('cuts long instructions and lists the nested files without loading them', async () => {
  const root = await folder({
    'AGENTS.md': 'a'.repeat(INSTRUCTIONS_CHARS + 10),
    'packages/ui/AGENTS.md': 'UI rules',
    'node_modules/lib/AGENTS.md': 'Not ours',
  });

  const snapshot = digest((await readLocal(root)) ?? { files: [], nested: [] });

  expect(snapshot.instructions?.cut).toBe(true);
  expect(snapshot.instructions?.text).toHaveLength(INSTRUCTIONS_CHARS);
  expect(snapshot.nested).toEqual(['packages/ui/AGENTS.md']);
});

it('reads a folder the same through the command a machine runs as on the gateway', async () => {
  const root = await folder({
    'AGENTS.md': 'Quote \'this\' and "that".',
    '.agents/skills/release/SKILL.md': skill('release'),
    'docs/CLAUDE.md': 'Docs rules',
  });

  const { stdout } = await sh('/bin/sh', ['-c', remoteCommand(root)]);
  const remote = digest(parseRemote(stdout, 0) ?? { files: [], nested: [] });
  const local = digest((await readLocal(root)) ?? { files: [], nested: [] });

  expect(remote).toEqual(local);
  expect(parseRemote('', 3)).toBeUndefined();
});

async function conversation(runOnMachine?: ConstructorParameters<typeof Workspaces>[1]) {
  let now = Date.UTC(2026, 10, 3, 9, 0, 0);
  const services = await testServices(() => now);
  const profile = await services.profiles.createProfile({
    name: 'Atlas',
    instructions: 'Help.',
    model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
  });
  const workspaces = new Workspaces(services.store, runOnMachine, () => now);
  const chat = await services.sessions.createSession(profile.id, { title: 'Work' });
  const run = { profileId: profile.id, sessionId: chat.id } as never;
  /** The conversation, working on `folders`, on a machine when one is named. */
  const at = (folders: string[], remoteMachineId?: string) =>
    ({ id: chat.id, folders, ...(remoteMachineId ? { remoteMachineId } : {}) }) as Session;
  const tick = (ms: number) => {
    now += ms;
  };
  return { services, profile, workspaces, run, tick, at };
}

it('tells a run its folders’ instructions, as their authors’, and names a clashing skill apart', async () => {
  const root = await folder({
    'AGENTS.md': 'Run make check.',
    '.agents/skills/lookup/SKILL.md': skill('lookup'),
  });
  const { workspaces, run, at } = await conversation();

  const project = await workspaces.forRun(run, at([root]), new Set(['lookup']));
  const name = root.split('/').at(-1);

  expect(project.sections[0]).toContain("written by the repository's authors");
  expect(project.sections[0]).toContain('never allow what your owner would not');
  expect(project.sections[0]).toContain('Run make check.');
  expect(project.skills.map((item) => item.name)).toEqual([`${name}/lookup`]);
});

it('reads a folder again only once its snapshot is a minute old, or the agent wrote to it', async () => {
  const root = await folder({ 'AGENTS.md': 'First rules.' });
  const { workspaces, run, tick, profile, at } = await conversation();
  const said = async () => (await workspaces.forRun(run, at([root]), new Set())).sections[0];

  expect(await said()).toContain('First rules.');
  await writeFile(join(root, 'AGENTS.md'), 'Second rules.');
  tick(30_000);
  expect(await said()).toContain('First rules.');
  tick(31_000);
  expect(await said()).toContain('Second rules.');

  await writeFile(join(root, 'AGENTS.md'), 'Third rules.');
  await workspaces.touched(profile.id, 'gateway', join(root, 'AGENTS.md'));
  expect(await said()).toContain('Third rules.');
});

it('goes on without a machine that does not answer, with what it last read', async () => {
  const machine = '33333333-3333-4333-8333-333333333333';
  const { services, workspaces, run, profile, at } = await conversation(
    () => new Promise(() => undefined),
  );

  const first = await workspaces.forRun(run, at(['/work/app'], machine), new Set());
  expect(first.sections[0]).toContain('could not be read yet');

  await services.store.db.insert(workspaceSnapshots).values({
    profileId: profile.id,
    location: machine,
    path: '/work/app',
    content: {
      instructions: { file: 'AGENTS.md', text: 'Remote rules.', cut: false },
      skills: [],
      nested: [],
    },
    hash: 'kept',
    readAt: new Date(0),
  });
  const later = await workspaces.forRun(run, at(['/work/app'], machine), new Set());
  expect(later.sections[0]).toContain('Remote rules.');
});

it('never tells one profile what another profile’s snapshot holds', async () => {
  const machine = '44444444-4444-4444-8444-444444444444';
  const { services, workspaces, run, at } = await conversation();
  const other = await services.profiles.createProfile({
    name: 'Other',
    instructions: 'Help.',
    model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
  });
  await services.store.db.insert(workspaceSnapshots).values({
    profileId: other.id,
    location: machine,
    path: '/work/app',
    content: {
      instructions: { file: 'AGENTS.md', text: 'Secret rules.', cut: false },
      skills: [],
      nested: [],
    },
    hash: 'other',
    readAt: new Date(),
  });

  const project = await workspaces.forRun(run, at(['/work/app'], machine), new Set());

  expect(project.sections.join('\n')).not.toContain('Secret rules.');
});

it('offers a folder’s skill to a run, loads it, and keeps it with the folder’s instructions', async () => {
  const root = await folder({
    'AGENTS.md': 'Run make check before a commit.',
    '.agents/skills/release/SKILL.md': skill('release'),
  });
  const services = await testServices();
  const profile = await services.profiles.createProfile({
    name: 'Atlas',
    instructions: 'Help.',
    model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
    contextPolicy: { inputTokens: 64_000 },
  });
  const chat = await services.sessions.createSession(profile.id, { title: 'Work' });
  // A desktop's own gateway lets a chat work on a folder; this one is set as such a chat would be.
  await services.store.db
    .update(sessions)
    .set({ workspace: { folders: [root] } })
    .where(eq(sessions.id, chat.id));
  const systems: string[] = [];
  const turn = async (text: string, first: unknown) => {
    let step = 0;
    const model = mockModel({
      doGenerate: async (options) => {
        if (!options.tools) return answer('Work');
        systems.push(
          options.prompt.flatMap((m) => (m.role === 'system' ? [m.content] : [])).join('\n'),
        );
        return (step++ === 0 ? first : answer('Done.')) as ReturnType<typeof answer>;
      },
    });
    const run = await services.runs.submit(profile.id, chat.id, { text, requestKey: text });
    await new AgentRuntime(services, () => model).execute(profile.id, run.id);
  };

  await turn('Release it', {
    content: [
      {
        type: 'tool-call' as const,
        toolCallId: 'skill',
        toolName: 'load_skill',
        input: JSON.stringify({ name: 'release' }),
      },
    ],
    finishReason: { unified: 'tool-calls' as const, raw: 'tool-calls' },
    usage,
    warnings: [],
  });
  await turn('And again', answer('Done.'));

  expect(systems[0]).toContain('Run make check before a commit.');
  expect(systems[0]).toContain('"name":"release"');
  expect(systems.at(-1)).toContain('## Skill: release');
  expect(systems.at(-1)).toContain('How to release.');
});

it('gives a subagent the instructions of the folders its conversation works on', async () => {
  const root = await folder({ 'AGENTS.md': 'Never touch the migrations folder.' });
  const services = await testServices();
  const profile = await services.profiles.createProfile({
    name: 'Atlas',
    instructions: 'Help.',
    model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
    contextPolicy: { inputTokens: 64_000 },
  });
  const chat = await services.sessions.createSession(profile.id, { title: 'Work' });
  await services.store.db
    .update(sessions)
    .set({ workspace: { folders: [root] } })
    .where(eq(sessions.id, chat.id));
  const parent = await services.runs.submit(profile.id, chat.id, {
    text: 'Fix it with a helper',
    requestKey: 'parent',
  });
  const own = await services.sessions.createSession(profile.id, { title: 'Helper' });
  const child = await services.runs.submit(
    profile.id,
    own.id,
    { text: 'Fix the bug', requestKey: 'child' },
    {
      subagent: {
        parentRunId: parent.id,
        spawnKey: 'fix',
        inputHash: 'a'.repeat(64),
        role: 'execute',
        name: 'Helper',
        identity: 'Fixes bugs.',
      },
    },
  );
  let system = '';
  const model = mockModel({
    doGenerate: async (options) => {
      if (options.tools) {
        system = options.prompt.flatMap((m) => (m.role === 'system' ? [m.content] : [])).join('\n');
      }
      return answer('Fixed.');
    },
  });

  await new AgentRuntime(services, () => model).execute(profile.id, child.id);

  expect(system).toContain('Never touch the migrations folder.');
});
