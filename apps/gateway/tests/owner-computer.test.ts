import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { fileTools } from '../src/agent/files.js';
import { localPlace } from '../src/agent/github-git-place.js';
import { shellTools } from '../src/agent/shell.js';
import { prepareGitAccess, prepareWorkerWorkspace } from '../src/agent/worker-workspace.js';
import { confine, confined, withFolders } from '../src/agent/workspace.js';
import {
  cloneRoot,
  projectCheckout,
  sessionCheckouts,
  workspaceHome,
  workspaceTemp,
} from '../src/agent/workspace-home.js';
import { buildContext } from '../src/context/build.js';
import { builtinSkills } from '../src/skills/builtin/index.js';
import { gitSshCommand } from '../src/ssh/git-ssh.js';
import { importWorkspaceSshKeys } from '../src/ssh/import.js';
import { testServices } from './helpers/services.js';

/**
 * The desktop app's local gateway, with a throwaway folder as the owner's home and another as the
 * app's data. `os.homedir()` reads HOME, so nothing here can reach the real one.
 */
const base = realpathSync(mkdtempSync(join(tmpdir(), 'jian-owner-')));
const saved = {
  HOME: process.env.HOME,
  TMPDIR: process.env.TMPDIR,
  JIAN_LOCAL_DIR: process.env.JIAN_LOCAL_DIR,
  JIAN_APP_DATA: process.env.JIAN_APP_DATA,
  JIAN_WORKSPACES: process.env.JIAN_WORKSPACES,
  SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
};
let home = '';
let appData = '';
let gateway = '';
let outside = '';

beforeEach(() => {
  const place = join(base, randomUUID());
  home = join(place, 'home');
  // Where a Mac keeps it, a space included: GIT_SSH_COMMAND has to survive that.
  appData = join(place, 'Application Support', 'Jian');
  gateway = join(appData, 'gateway');
  outside = join(place, 'elsewhere');
  mkdirSync(home, { recursive: true });
  mkdirSync(gateway, { recursive: true });
  mkdirSync(outside, { recursive: true });
  mkdirSync(join(place, 'tmp'));
  process.env.HOME = home;
  process.env.TMPDIR = join(place, 'tmp');
  process.env.JIAN_LOCAL_DIR = gateway;
  process.env.JIAN_APP_DATA = appData;
  // Set on the machine or not, a desktop does not look at it.
  process.env.JIAN_WORKSPACES = join(place, 'not-used');
});

afterAll(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  rmSync(base, { recursive: true, force: true });
});

const call = (tool: unknown, input: unknown) =>
  (tool as { execute: (input: unknown, context: unknown) => Promise<unknown> }).execute(input, {
    toolCallId: 'test',
    messages: [],
    context: {},
  });
const read = (path: string) => call(fileTools().read_file, { path, offset: 1, limit: 10 });
const sh = (command: string, access?: Parameters<typeof shellTools>[0]) =>
  call(shellTools(access).run_command, { command, timeoutMs: 10_000 }) as Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
const homeEntries = () => readdirSync(home).sort();

describe('where agents work on a desktop', () => {
  it('starts commands in the real home, or in the chat’s first folder', async () => {
    const real = realpathSync(home);

    expect(await workspaceHome()).toBe(real);
    expect((await sh('pwd; echo "$HOME"')).stdout).toBe(`${real}\n${real}\n`);

    const folder = realpathSync(outside);
    const inFolder = await withFolders([folder], () => sh('pwd'));
    expect(inFolder.stdout).toBe(`${folder}\n`);
  });

  it('never confines a command, even with a helper present', async () => {
    process.env.JIAN_SANDBOX = '/bin/echo';
    try {
      await expect(confined(home, '/bin/sh', ['-c', 'true'])).resolves.toEqual({
        file: '/bin/sh',
        args: ['-c', 'true'],
      });
    } finally {
      delete process.env.JIAN_SANDBOX;
    }
  });

  it('keeps temporary files in the system’s temporary folder, never in the home', async () => {
    const temp = await workspaceTemp();

    expect(temp.startsWith(realpathSync(process.env.TMPDIR as string))).toBe(true);
    expect((await sh('echo "$TMPDIR"')).stdout).toBe(`${temp}\n`);
    expect(existsSync(join(home, 'tmp'))).toBe(false);
  });

  it('gives a command the owner’s tools and SSH agent, and none of the gateway’s secrets', async () => {
    const before = { PATH: process.env.PATH, JIAN_MASTER_KEY: process.env.JIAN_MASTER_KEY };
    const ownBin = join(home, '.cargo', 'bin');
    process.env.PATH = `${ownBin}:${before.PATH}`;
    process.env.JIAN_MASTER_KEY = 'c3ludGhldGlj';
    process.env.SSH_AUTH_SOCK = join(home, 'agent.sock');
    try {
      const { stdout } = await sh('env');
      const env = Object.fromEntries(
        stdout
          .trim()
          .split('\n')
          .map((line) => line.split('=', 2)),
      );

      expect(env.PATH?.split(':')[0]).toBe(ownBin);
      expect(env.SSH_AUTH_SOCK).toBe(join(home, 'agent.sock'));
      expect(env.JIAN_MASTER_KEY).toBeUndefined();
      expect(env.JIAN_LOCAL_DIR).toBeUndefined();
      expect(env.JIAN_APP_DATA).toBeUndefined();
      // Jian's own install paths would change where the owner's tools install.
      expect(env.NPM_CONFIG_PREFIX).toBeUndefined();
      expect(env.GOPATH).toBeUndefined();
    } finally {
      process.env.PATH = before.PATH;
      if (before.JIAN_MASTER_KEY === undefined) delete process.env.JIAN_MASTER_KEY;
      else process.env.JIAN_MASTER_KEY = before.JIAN_MASTER_KEY;
      delete process.env.SSH_AUTH_SOCK;
    }
  });
});

describe('what the file tools reach on a desktop', () => {
  it('reads and writes a path outside the home', async () => {
    const file = join(outside, 'notes.md');
    writeFileSync(file, 'outside');

    await expect(read(file)).resolves.toMatchObject({ content: '1\toutside' });
    await call(fileTools().write_file, { path: join(outside, 'new.md'), content: 'written' });
    expect(readFileSync(join(outside, 'new.md'), 'utf8')).toBe('written');
  });

  it('refuses Jian’s own data, in plain words, also through a link', async () => {
    const credentials = join(appData, 'local-gateway.json');
    const database = join(gateway, 'database', 'PG_VERSION');
    mkdirSync(join(gateway, 'database'));
    writeFileSync(credentials, '{"token":"synthetic"}');
    writeFileSync(database, '16');
    symlinkSync(credentials, join(home, 'link.json'));
    symlinkSync(appData, join(home, 'data-link'));

    const refused = "Jian's own data";

    await expect(read(credentials)).rejects.toThrow(refused);
    await expect(read(database)).rejects.toThrow(refused);
    await expect(read(join(home, 'link.json'))).rejects.toThrow(refused);
    await expect(read(join(home, 'data-link', 'local-gateway.json'))).rejects.toThrow(refused);
    await expect(call(fileTools().list_directory, { path: appData })).rejects.toThrow(refused);
    await expect(
      call(fileTools().write_file, { path: join(gateway, 'planted'), content: 'x' }),
    ).rejects.toThrow(refused);
    // A chat's folder opens nothing that was closed, and neither does a file not there yet.
    await expect(
      withFolders([realpathSync(appData)], () => confine(credentials, 'read')),
    ).rejects.toThrow(refused);
    await expect(confine(join(appData, 'not-yet'), 'write')).rejects.toThrow(refused);
    expect(existsSync(join(gateway, 'planted'))).toBe(false);
  });

  it('reaches the old workspaces folder, but no link in it leads back to what is closed', async () => {
    const earlier = join(gateway, 'workspaces', randomUUID(), 'project');
    mkdirSync(earlier, { recursive: true });
    writeFileSync(join(earlier, 'notes.md'), 'earlier work');
    writeFileSync(join(appData, 'machines.json'), '{}');
    symlinkSync(join(appData, 'machines.json'), join(earlier, 'machines.json'));

    await expect(read(join(earlier, 'notes.md'))).resolves.toMatchObject({
      content: '1\tearlier work',
    });
    await expect(read(join(earlier, 'machines.json'))).rejects.toThrow("Jian's own data");
  });

  it('refuses the gateway’s own process', async () => {
    await expect(confine(`/proc/${process.pid}/environ`, 'read')).rejects.toThrow(
      "Jian's own data",
    );
    await expect(confine(`/proc/${process.ppid}/environ`, 'read')).rejects.toThrow(
      "Jian's own data",
    );
  });

  it('leaves Jian’s own data out of a search and a listing that start above it', async () => {
    const tools = fileTools();
    const place = join(appData, '..', '..');
    const needle = `needle-${randomUUID()}`;
    writeFileSync(join(appData, 'secret.txt'), `${needle}\n`);
    writeFileSync(join(outside, 'open.txt'), `${needle}\n`);
    const open = join(gateway, 'workspaces', randomUUID());
    mkdirSync(open, { recursive: true });
    writeFileSync(join(open, 'earlier.txt'), `${needle}\n`);

    const search = (path: string) =>
      call(tools.search_files, {
        pattern: needle,
        path,
        ignoreCase: false,
        contextLines: 0,
        output: 'content',
        limit: 50,
      }) as Promise<{ matches: string }>;
    const { matches } = await search(realpathSync(place));

    expect(matches).toContain('open.txt');
    expect(matches).not.toContain('secret.txt');
    // Named outright, the folder left open is searched like any other.
    expect((await search(open)).matches).toContain(needle);

    const found = (await call(tools.find_files, {
      pattern: '**/*.txt',
      path: realpathSync(place),
      limit: 50,
    })) as { files: string[] };
    expect(found.files.join('\n')).toContain('open.txt');
    expect(found.files.join('\n')).not.toContain('secret.txt');
  });

  it('holds a subagent’s repositories to the same line', async () => {
    const run = (repositories: string[]) =>
      prepareWorkerWorkspace({
        id: randomUUID(),
        profileId: randomUUID(),
        subagent: { repositories },
      } as never);
    const repository = join(outside, 'repository');
    mkdirSync(repository);

    await expect(run([repository])).resolves.toBeDefined();
    await expect(run([gateway])).rejects.toThrow("outside Jian's own data");
  });
});

describe('what starting up and syncing keys leaves in the owner’s home', () => {
  it('writes nothing there, with or without keys', async () => {
    const services = await testServices();
    const before = homeEntries();

    await importWorkspaceSshKeys(services.store, services.gatewayVault);
    await prepareGitAccess(services.sshKeys);
    await services.sshKeys.create({ name: 'Deploy' });
    await prepareGitAccess(services.sshKeys);
    await workspaceHome();
    await workspaceTemp();
    await cloneRoot();
    await projectCheckout(randomUUID(), randomUUID(), randomUUID());
    await sh('true');

    expect(before).toEqual([]);
    expect(homeEntries()).toEqual([]);
    for (const dotfile of ['.ssh', '.gitconfig', 'tmp', 'Jian', '.config']) {
      expect(existsSync(join(home, dotfile))).toBe(false);
    }
  });

  it('leaves the owner’s own SSH files exactly as they were', async () => {
    const services = await testServices();
    const ssh = join(home, '.ssh');
    mkdirSync(ssh);
    const theirs = {
      id_ed25519: '-----BEGIN OPENSSH PRIVATE KEY-----\nowner\n',
      known_hosts: 'git.example.invalid synthetic-host-key\n',
      config: 'Host git.example.invalid\n  User owner\n',
    };
    for (const [name, text] of Object.entries(theirs)) writeFileSync(join(ssh, name), text);
    writeFileSync(join(home, '.gitconfig'), '[user]\n  name = Sample Owner\n');

    await services.sshKeys.create({ name: 'Deploy' });
    await prepareGitAccess(services.sshKeys);

    expect(readdirSync(ssh).sort()).toEqual(Object.keys(theirs).sort());
    for (const [name, text] of Object.entries(theirs)) {
      expect(readFileSync(join(ssh, name), 'utf8')).toBe(text);
    }
    expect(readFileSync(join(home, '.gitconfig'), 'utf8')).toBe('[user]\n  name = Sample Owner\n');
  });
});

describe('the keys the installation manages on a desktop', () => {
  it('keeps them in Jian’s data, refused to the file tools, with their own known_hosts', async () => {
    const services = await testServices();
    const key = await services.sshKeys.create({ name: 'Deploy' });
    await services.sshKeys.sync();
    await gitSshCommand();

    const file = join(gateway, 'ssh', key.id, 'id_ed25519');
    expect(readFileSync(file, 'utf8')).toContain('PRIVATE KEY');
    expect(readFileSync(join(gateway, 'ssh', 'known_hosts'), 'utf8')).toContain('github.com');
    await expect(read(file)).rejects.toThrow("Jian's own data");

    await services.sshKeys.remove(key.id);
    expect(existsSync(join(gateway, 'ssh', key.id))).toBe(false);
  });

  it('does not set GIT_SSH_COMMAND until there is a key, so the owner’s setup stays in force', async () => {
    const services = await testServices();

    expect(await prepareGitAccess(services.sshKeys)).toEqual({ readOnly: [], writable: [] });
    expect((await sh('echo "[$GIT_SSH_COMMAND]"')).stdout).toBe('[]\n');
  });

  it('adds them to the owner’s SSH setup and replaces none of it', async () => {
    const services = await testServices();
    const key = await services.sshKeys.create({ name: 'Deploy' });
    const access = await prepareGitAccess(services.sshKeys);
    const realHome = realpathSync(home);
    const ssh = join(realHome, '.ssh');

    // `-F` so the check reads no configuration of the real user's: the command itself has none.
    expect(access.sshCommand).not.toContain("'-F'");
    expect(access.sshCommand).not.toContain('IdentitiesOnly');

    const { stdout, exitCode } = await sh(
      'eval "$GIT_SSH_COMMAND -F /dev/null -G git.example.invalid"',
      access,
    );

    expect(exitCode).toBe(0);
    const managedRoot = join(realpathSync(gateway), 'ssh');
    expect(stdout).toContain(`identityfile ${join(gateway, 'ssh', key.id, 'id_ed25519')}`);
    expect(stdout).toContain(`identityfile ${join(ssh, 'id_ed25519')}`);
    expect(stdout).toContain(`identityfile ${join(ssh, 'id_rsa')}`);
    expect(stdout).not.toContain('identitiesonly yes');
    // Ours first, which is where OpenSSH adds a new host, never to the owner's own file.
    const hosts = stdout.split('\n').find((line) => line.startsWith('userknownhostsfile'));
    expect(hosts?.indexOf(join(managedRoot, 'known_hosts'))).toBeGreaterThan(-1);
    expect(hosts?.indexOf(join(ssh, 'known_hosts'))).toBeGreaterThan(
      hosts?.indexOf(join(managedRoot, 'known_hosts')) as number,
    );
    expect(existsSync(ssh)).toBe(false);
  });

  it('imports from old per-profile folders, once, not from the owner’s home', async () => {
    const services = await testServices();
    const write = (folder: string, id: string, name: string) => {
      mkdirSync(folder, { recursive: true });
      execFileSync('/usr/bin/ssh-keygen', [
        '-q',
        '-t',
        'ed25519',
        '-N',
        '',
        '-C',
        name,
        '-f',
        join(folder, 'id_ed25519'),
      ]);
      writeFileSync(join(folder, 'metadata.json'), JSON.stringify({ id, name }));
    };
    const id = randomUUID();
    write(join(gateway, 'workspaces', randomUUID(), '.ssh', 'jian', id), id, 'Deploy');
    // A folder in the owner's home that happens to be laid out the same way is theirs.
    const other = randomUUID();
    write(join(home, randomUUID(), '.ssh', 'jian', other), other, 'Not ours');

    expect(await importWorkspaceSshKeys(services.store, services.gatewayVault)).toBe(1);
    expect(await importWorkspaceSshKeys(services.store, services.gatewayVault)).toBe(0);
    expect((await services.sshKeys.list()).map((key) => key.id)).toEqual([id]);
  });
});

describe('where clones go on a desktop', () => {
  const place = () => localPlace({ readOnly: [], writable: [] });

  it('puts a clone with no chosen folder under ~/Jian, and makes that folder only then', async () => {
    const real = realpathSync(home);

    await expect(place().checkout(undefined, 'site', false)).resolves.toBe(
      join(real, 'Jian', 'site'),
    );
    expect(existsSync(join(home, 'Jian'))).toBe(false);

    await expect(place().checkout(undefined, 'site', true)).resolves.toBe(
      join(real, 'Jian', 'site'),
    );
    expect(existsSync(join(home, 'Jian'))).toBe(true);
  });

  it('puts one in the chat’s first folder when it has one', async () => {
    const folder = realpathSync(outside);

    await expect(
      withFolders([folder], () => place().checkout(undefined, 'site', true)),
    ).resolves.toBe(join(folder, 'site'));
  });

  it('refuses a clone into Jian’s own data', async () => {
    await expect(place().checkout(join(gateway, 'site'), 'site', true)).rejects.toThrow(
      "Jian's own data",
    );
  });

  it('keeps a conversation’s checkouts beneath ~/Jian', async () => {
    const real = realpathSync(home);
    const [profile, project, session] = [randomUUID(), randomUUID(), randomUUID()];

    expect(await projectCheckout(profile, project, session)).toBe(
      join(real, 'Jian', 'projects', project, 'sessions', session),
    );
    expect(await sessionCheckouts(profile, session)).toBe(
      join(real, 'Jian', 'projects', 'sessions', session),
    );
  });

  it('keeps a checkout an earlier version made, rather than cloning again beside it', async () => {
    const [profile, project, session] = [randomUUID(), randomUUID(), randomUUID()];
    const earlier = join(gateway, 'workspaces', profile, 'projects', project, 'sessions', session);
    mkdirSync(earlier, { recursive: true });

    expect(await projectCheckout(profile, project, session)).toBe(realpathSync(earlier));
    expect(existsSync(join(home, 'Jian'))).toBe(false);
  });
});

describe('what an agent is told on a desktop', () => {
  const skill = (name: string) =>
    builtinSkills([]).find((item) => item.name === name)?.instructions ?? '';

  it('says what is true here, with nothing of a server’s', () => {
    const machine = skill('machine-tools');

    expect(machine).toContain("the owner's real home");
    expect(machine).toContain("Jian's own data");
    expect(machine).toContain('~/Jian');
    expect(machine).not.toMatch(/JIAN_TOOLBOX|jian-display|without \\?`sudo/);
    expect(skill('ssh-keys')).toContain("never in the owner's");
    expect(skill('ssh-keys')).not.toContain('already in');
  });

  it('tells a run where it is in its context', async () => {
    expect(await systemPrompt()).toContain("The file tools refuse only Jian's own data.");
  });

  it('tells a run on a server that other agents share these files', async () => {
    delete process.env.JIAN_LOCAL_DIR;
    delete process.env.JIAN_APP_DATA;

    expect(await systemPrompt()).toContain('shared by every agent');
    expect(skill('machine-tools')).toContain('Do not assume you are');
    expect(skill('machine-tools')).toContain('alone in');
  });
});

/** The system prompt of a plain run, which names the host in one of its lines. */
async function systemPrompt(): Promise<string> {
  const services = await testServices();
  const profile = await services.profiles.createProfile({
    name: 'Atlas',
    instructions: 'Help.',
    model: { provider: 'openai', modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' },
  });
  const session = await services.sessions.createSession(profile.id, { title: 'Host' });
  const run = await services.runs.submit(profile.id, session.id, { text: 'Hi', requestKey: 'one' });

  return buildContext(run, { memories: [], history: [], servers: [], activities: [] }).system;
}
