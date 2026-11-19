import { randomBytes } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Profile, Run } from '@jian/contracts';
import { profileSchema } from '@jian/contracts';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { profileTools, skillFor } from '../src/agent/tools.js';
import { createApp } from '../src/app.js';
import { disposition, plainName } from '../src/file-links/serve.js';
import { FileLinks } from '../src/file-links/service.js';
import { SecretBox } from '../src/security/crypto.js';
import { GatewayVault } from '../src/security/gateway-vault.js';
import { Vault } from '../src/security/vault.js';
import { buildServices } from '../src/services.js';
import { fileLinks } from '../src/storage/schema.js';
import { projectRow } from './helpers/rows.js';
import { testServices } from './helpers/services.js';

const token = 'test-token-that-is-at-least-32-characters';
const model = { provider: 'openai' as const, modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' };
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

/** A gateway on a server at an https:// address, its shared directory a fresh folder. */
async function setup() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'jian-links-')));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'jian-links-outside-')));
  let now = Date.parse('2026-11-19T12:00:00Z');
  const clock = () => now;
  const services = await testServices(clock);
  const links = new FileLinks(services.store, 'https://jian.example.test', clock, async () => home);
  const app = createApp({ ...services, fileLinks: links, token, logger: false });
  apps.push(app);
  const agent = async (name: string) => {
    const profile = await services.profiles.createProfile({ name, instructions: 'Help.', model });
    const session = await services.sessions.createSession(profile.id, { title: 'Ads' });
    return { profileId: profile.id, sessionId: session.id };
  };
  const write = (path: string, data: string | Buffer) => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, data);
    return path;
  };
  const read = (url: string, headers: Record<string, string> = {}, method = 'GET') =>
    app.inject({ method: method as 'GET', url: new URL(url).pathname, headers });

  return {
    home,
    outside,
    services,
    links,
    app,
    agent,
    write,
    read,
    later: (ms: number) => {
      now += ms;
    },
  };
}

describe('file links', () => {
  it('serves the whole file, a range of it and its headers, to anyone holding the link', async () => {
    const { home, links, agent, write, read } = await setup();
    const owner = await agent('Studio');
    const bytes = randomBytes(5000);
    write(join(home, 'ads', 'final cut.mp4'), bytes);

    const made = await links.create(owner, { path: join(home, 'ads', 'final cut.mp4') });
    expect(made.url).toMatch(
      /^https:\/\/jian\.example\.test\/v1\/file-links\/[A-Za-z0-9_-]{43}\/final-cut\.mp4$/,
    );
    expect(made.bytes).toBe(5000);
    expect(Date.parse(made.expiresAt) - Date.parse('2026-11-19T12:00:00Z')).toBe(60 * 60_000);

    const whole = await read(made.url);
    expect(whole.statusCode).toBe(200);
    expect(whole.rawPayload.equals(bytes)).toBe(true);
    expect(whole.headers['content-type']).toBe('video/mp4');
    expect(whole.headers['content-length']).toBe('5000');
    expect(whole.headers['accept-ranges']).toBe('bytes');
    expect(whole.headers['content-disposition']).toMatch(/^inline; filename="final-cut\.mp4"/);
    expect(whole.headers['x-content-type-options']).toBe('nosniff');
    expect(whole.headers['content-security-policy']).toBe(
      "default-src 'none'; frame-ancestors 'none'; sandbox",
    );
    expect(whole.headers['referrer-policy']).toBe('no-referrer');
    expect(whole.headers['cache-control']).toBe('private, max-age=3600');

    const part = await read(made.url, { range: 'bytes=100-199' });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe('bytes 100-199/5000');
    expect(part.headers['content-length']).toBe('100');
    expect(part.rawPayload.equals(bytes.subarray(100, 200))).toBe(true);

    const tail = await read(made.url, { range: 'bytes=-10' });
    expect(tail.statusCode).toBe(206);
    expect(tail.rawPayload.equals(bytes.subarray(4990))).toBe(true);

    const past = await read(made.url, { range: 'bytes=5000-' });
    expect(past.statusCode).toBe(416);
    expect(past.headers['content-range']).toBe('bytes */5000');

    const head = await read(made.url, {}, 'HEAD');
    expect(head.statusCode).toBe(200);
    expect(head.headers['content-length']).toBe('5000');
    expect(head.body).toBe('');
  });

  it('answers an expired, revoked, unknown or malformed link with the same bare 404', async () => {
    const { home, links, agent, write, read, later } = await setup();
    const owner = await agent('Studio');
    const file = write(join(home, 'photo.png'), randomBytes(64));

    const short = await links.create(owner, { path: file, minutes: 1 });
    const revoked = await links.create(owner, { path: file });
    const byUrl = await links.create(owner, { path: file });

    expect(await links.revoke(owner.profileId, revoked.linkId)).toEqual({
      linkId: revoked.linkId,
      revoked: true,
    });
    await links.revoke(owner.profileId, byUrl.url);
    later(61_000);

    const unknown = `https://jian.example.test/v1/file-links/${randomBytes(32).toString('base64url')}/x.png`;
    const answers = await Promise.all(
      [short.url, revoked.url, byUrl.url, unknown, 'https://x.test/v1/file-links/short/x'].map(
        (url) => read(url),
      ),
    );
    for (const answer of answers) {
      expect(answer.statusCode).toBe(404);
      expect(answer.json()).toEqual({ error: 'Not found' });
      expect(answer.headers['x-content-type-options']).toBe('nosniff');
    }
    expect((await read(revoked.url, {}, 'HEAD')).statusCode).toBe(404);
  });

  it('lets only the agent that made a link revoke it', async () => {
    const { home, links, agent, write, read } = await setup();
    const owner = await agent('Studio');
    const other = await agent('Ledger');
    const made = await links.create(owner, { path: write(join(home, 'a.mp3'), 'id3') });

    await expect(links.revoke(other.profileId, made.linkId)).rejects.toThrow(/No live link/);
    await expect(links.revoke(other.profileId, made.url)).rejects.toThrow(/No live link/);
    expect((await read(made.url)).statusCode).toBe(200);
  });

  it('stores only a hash of the token', async () => {
    const { home, links, agent, write, services } = await setup();
    const owner = await agent('Studio');
    const made = await links.create(owner, { path: write(join(home, 'b.wav'), 'RIFF') });
    const secret = /file-links\/([^/]+)\//.exec(made.url)?.[1] as string;

    const rows = await services.store.db.select().from(fileLinks);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(secret);
    expect(rows[0]?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]?.path).toBe('b.wav');
  });

  it('refuses at creation anything outside the shared directory, hidden or not a file', async () => {
    const { home, outside, links, agent, write } = await setup();
    const owner = await agent('Studio');
    const secret = write(join(outside, 'secret.txt'), 'key');
    write(join(home, 'inside.txt'), 'ok');
    symlinkSync(secret, join(home, 'leads-out.txt'));
    symlinkSync(outside, join(home, 'folder-out'));
    write(join(home, '.ssh', 'id_ed25519'), 'private');
    write(join(home, 'work', '.env'), 'TOKEN=x');
    mkdirSync(join(home, 'renders'));

    const refused = async (path: string, reason: RegExp) =>
      expect(links.create(owner, { path })).rejects.toThrow(reason);

    await refused(`${home}/../${outside.split('/').at(-1)}/secret.txt`, /outside/);
    await refused(secret, /outside/);
    await refused('/etc/hosts', /outside/);
    await refused('inside.txt', /absolute/);
    await refused(join(home, 'leads-out.txt'), /outside/);
    await refused(join(home, 'folder-out', 'secret.txt'), /outside/);
    await refused(join(home, '.ssh', 'id_ed25519'), /hidden/);
    await refused(join(home, 'work', '.env'), /hidden/);
    await refused(join(home, 'renders'), /folder/);
    await refused(join(home, 'missing.mp4'), /does not exist/);
    await refused(write(join(home, 'empty.mp4'), ''), /empty/);
    await expect(
      links.create(owner, { path: join(home, 'inside.txt'), minutes: 7 * 24 * 60 + 1 }),
    ).rejects.toThrow(/7 days/);
  });

  it('refuses at serve time a file swapped for a symlink, changed or deleted since', async () => {
    const { home, outside, links, agent, write, read } = await setup();
    const owner = await agent('Studio');
    const secret = write(join(outside, 'secret.txt'), 'same size');
    const swapped = write(join(home, 'swapped.txt'), 'same size');
    const changed = write(join(home, 'changed.txt'), 'first');
    const deleted = write(join(home, 'deleted.txt'), 'gone');
    write(join(home, 'dir', 'nested.txt'), 'nested');

    const made = {
      swapped: await links.create(owner, { path: swapped }),
      changed: await links.create(owner, { path: changed }),
      deleted: await links.create(owner, { path: deleted }),
      nested: await links.create(owner, { path: join(home, 'dir', 'nested.txt') }),
    };

    rmSync(swapped);
    symlinkSync(secret, swapped);
    writeFileSync(changed, 'second, longer');
    rmSync(deleted);
    // A folder on the way replaced by a link out.
    rmSync(join(home, 'dir'), { recursive: true });
    mkdirSync(join(outside, 'dir'));
    writeFileSync(join(outside, 'dir', 'nested.txt'), 'nested');
    symlinkSync(join(outside, 'dir'), join(home, 'dir'));

    for (const link of Object.values(made)) {
      expect((await read(link.url)).statusCode).toBe(404);
    }
  });

  it('notices a file rewritten to the same size', async () => {
    const { home, links, agent, write, read } = await setup();
    const owner = await agent('Studio');
    const file = write(join(home, 'voice.mp3'), 'aaaa');
    utimesSync(file, new Date('2026-11-01T00:00:00Z'), new Date('2026-11-01T00:00:00Z'));
    const made = await links.create(owner, { path: file });

    writeFileSync(file, 'bbbb');
    utimesSync(file, new Date('2026-11-02T00:00:00Z'), new Date('2026-11-02T00:00:00Z'));
    expect((await read(made.url)).statusCode).toBe(404);
  });

  it("refuses another agent's own folder, project and conversation checkouts", async () => {
    const { home, links, agent, write, services } = await setup();
    const owner = await agent('Studio');
    const other = await agent('Ledger');
    const theirProject = await projectRow(services.store, other.profileId, 'https://x.test/a/b');
    const ownProject = await projectRow(services.store, owner.profileId, 'https://x.test/a/c');

    const theirs = [
      write(join(home, other.profileId, 'notes.txt'), 'theirs'),
      write(join(home, 'projects', theirProject.id, 'sessions', 'x', 'out.txt'), 'theirs'),
      write(join(home, 'projects', 'sessions', other.sessionId, 'repo', 'out.txt'), 'theirs'),
    ];
    for (const path of theirs) {
      await expect(links.create(owner, { path })).rejects.toThrow(/another agent/);
    }

    const mine = [
      write(join(home, owner.profileId, 'notes.txt'), 'mine'),
      write(join(home, 'projects', ownProject.id, 'sessions', 'x', 'out.txt'), 'mine'),
      write(join(home, 'projects', 'sessions', owner.sessionId, 'repo', 'out.txt'), 'mine'),
      write(join(home, 'shared', 'out.txt'), 'shared'),
    ];
    for (const path of mine) {
      await expect(links.create(owner, { path })).resolves.toMatchObject({
        bytes: expect.any(Number),
      });
    }
  });

  it('saves a page or script instead of drawing it at the gateway address', async () => {
    const { home, links, agent, write, read } = await setup();
    const owner = await agent('Studio');
    const made = await links.create(owner, {
      path: write(join(home, 'page.html'), '<script>1</script>'),
    });

    const answer = await read(made.url);
    expect(answer.statusCode).toBe(200);
    // A page is never drawn at the gateway's address: it is saved.
    expect(answer.headers['content-disposition']).toMatch(/^attachment; filename="page\.html"/);
    expect(answer.headers['content-type']).toMatch(/^text\/html/);
  });

  it('opens HEAD only where GET is open: an owner route still wants the token', async () => {
    const { app } = await setup();

    expect((await app.inject({ method: 'HEAD', url: '/v1/providers' })).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: 'HEAD',
          url: '/v1/providers',
          headers: { authorization: `Bearer ${token}` },
        })
      ).statusCode,
    ).toBe(200);
  });
});

describe('where links are offered', () => {
  const box = () => new SecretBox({ activeKeyId: 'test', keys: { test: randomBytes(32) } });

  it('exists only on a server gateway with an https:// public address', async () => {
    const { store } = await testServices();
    const build = (mode: 'server' | 'local', publicUrl?: string) =>
      buildServices({
        store,
        vault: new Vault(store, box()),
        gatewayVault: new GatewayVault(store, box()),
        mode,
        ...(publicUrl ? { publicUrl } : {}),
      }).fileLinks;

    expect(build('server', 'https://jian.example.test')).toBeInstanceOf(FileLinks);
    expect(build('server', 'http://jian.example.test')).toBeUndefined();
    expect(build('server')).toBeUndefined();
    expect(build('local', 'https://jian.example.test')).toBeUndefined();
  });

  it('gives the tools and the skill only to a run whose files are on such a gateway', async () => {
    const profile: Profile = {
      ...profileSchema.parse({ name: 'Studio', instructions: 'Help.', summary: 'Ads' }),
      id: '11111111-1111-4111-8111-111111111111',
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const run: Run = {
      id: '22222222-2222-4222-8222-222222222222',
      profileId: profile.id,
      sessionId: '33333333-3333-4333-8333-333333333333',
      requestKey: 'k',
      input: 'Hi',
      status: 'running',
      profile,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    // Only which tools are offered is under test: nothing here is called.
    const stub = new Proxy({}, { get: () => new Proxy({}, { get: () => async () => [] }) });
    const withLinks = stub as never;
    const without = new Proxy(stub, {
      get: (target, name) =>
        name === 'fileLinks' ? undefined : Reflect.get(target, name as string),
    }) as never;

    expect(profileTools(withLinks, run)).toHaveProperty('share_file_link');
    expect(profileTools(withLinks, run)).toHaveProperty('revoke_file_link');
    expect(profileTools(without, run)).not.toHaveProperty('share_file_link');
    // A conversation on another machine has its files there, where no link reaches.
    expect(profileTools(withLinks, run, undefined, 'machine-1')).not.toHaveProperty(
      'share_file_link',
    );

    const media = (links: boolean) =>
      skillFor(run, [], 'media', {
        web: { browser: false, inspects: true, subagent: false },
        xConnected: false,
        links,
      })?.instructions ?? '';
    expect(media(true)).toContain('share_file_link');
    expect(media(true)).toContain('revoke_file_link');
    expect(media(false)).not.toMatch(/share_file_link|revoke_file_link/);
  });
});

describe('the name a linked file is saved under', () => {
  it('cannot end the header or add a field to it', () => {
    for (const name of [
      'a"; filename="evil.exe',
      'line\r\nSet-Cookie: x=1.mp4',
      'back\\slash.mp4',
      '..‮gnp.exe',
    ]) {
      const header = disposition(name, 'video/mp4');
      expect(header).not.toMatch(/[\r\n]/);
      const [, plain] = /filename="([^"]*)"/.exec(header) ?? [];
      expect(plain).toMatch(/^[A-Za-z0-9._-]+$/);
      expect(header.match(/"/g)).toHaveLength(2);
      expect(header).toMatch(/filename\*=UTF-8''[A-Za-z0-9%._~-]+$/);
    }
  });

  it('keeps a readable ASCII name and the real one beside it', () => {
    expect(disposition('Anúncio de verão.mp4', 'video/mp4')).toBe(
      'inline; filename="Anuncio-de-verao.mp4"; filename*=UTF-8\'\'An%C3%BAncio%20de%20ver%C3%A3o.mp4',
    );
    expect(disposition('report.pdf', 'application/pdf')).toMatch(/^attachment;/);
    expect(plainName('.hidden')).toBe('hidden');
    expect(plainName('***')).toBe('file');
    expect(plainName(`${'a'.repeat(300)}.mp4`)).toHaveLength(100);
  });
});
