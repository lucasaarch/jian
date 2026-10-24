import { randomUUID } from 'node:crypto';
import { type Profile, profileRecordSchema } from '@jian/contracts';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { probeMcpServer } from '../src/agent/mcp-probe.js';
import { workspaceOf } from '../src/agent/workspace.js';
import { createApp } from '../src/app.js';
import type { Profiles } from '../src/profiles/service.js';
import { SshKeys } from '../src/ssh/service.js';
import { profiles, remoteTasks } from '../src/storage/schema.js';
import { testServices } from './helpers/services.js';

const effects = vi.hoisted(() => ({
  connect: vi.fn(),
  tools: vi.fn(async () => ({})),
  close: vi.fn(async () => undefined),
}));
vi.mock('../src/agent/mcp-negotiate.js', () => ({
  createNegotiatedMcpClient: effects.connect,
}));
vi.mock('../src/agent/mcp-stdio.js', () => ({ stdioTransport: vi.fn(() => ({})) }));
vi.mock('../src/agent/workspace.js', () => ({
  workspaceOf: vi.fn(async () => {
    throw new Error('workspace effect reached');
  }),
}));

const profile = (professionId: Profile['professionId']) =>
  profileRecordSchema.parse({
    id: randomUUID(),
    name: 'Effect guard',
    instructions: 'Help.',
    professionId,
    version: 1,
    createdAt: '2026-10-24T00:00:00Z',
    updatedAt: '2026-10-24T00:00:00Z',
  });

beforeEach(() => {
  vi.clearAllMocks();
  effects.connect.mockResolvedValue({ tools: effects.tools, close: effects.close });
});

describe('SSH effect boundary', () => {
  it('refuses list, create and remove before workspace creation or known-host setup', async () => {
    const attendant = profile('attendant');
    const service = new SshKeys({ profile: vi.fn(async () => attendant) } as unknown as Profiles);
    await expect(service.list(attendant.id)).rejects.toMatchObject({ statusCode: 403 });
    await expect(service.create(attendant.id, { name: 'blocked' })).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(service.remove(attendant.id, randomUUID())).rejects.toMatchObject({
      statusCode: 403,
    });
    expect(workspaceOf).not.toHaveBeenCalled();
  });

  it.each(['developer', null] as const)(
    'preserves workspace access for %s profiles',
    async (profession) => {
      const allowed = profile(profession);
      const service = new SshKeys({ profile: vi.fn(async () => allowed) } as unknown as Profiles);
      await expect(service.list(allowed.id)).rejects.toThrow('workspace effect reached');
      expect(workspaceOf).toHaveBeenCalledWith(allowed.id);
    },
  );

  it('does not treat unknown profession authority as legacy', async () => {
    const unknown = { ...profile(null), professionId: 'future' as never };
    const service = new SshKeys({ profile: vi.fn(async () => unknown) } as unknown as Profiles);
    await expect(service.list(unknown.id)).rejects.toMatchObject({ statusCode: 403 });
    expect(workspaceOf).not.toHaveBeenCalled();
  });
});

describe('MCP probe effect boundary', () => {
  it('denies attendant stdio before vault access, OAuth provider creation or connection', async () => {
    const services = await testServices();
    const attendant = profileRecordSchema.parse({
      ...profile('attendant'),
      mcpServers: [
        {
          name: 'local',
          transport: 'stdio',
          command: 'must-not-run',
          env: [{ name: 'SECRET' }],
        },
      ],
    });
    const read = vi.spyOn(services.vault, 'read');
    const oauth = vi.fn();
    await expect(
      probeMcpServer(attendant, 'local', services.vault, vi.fn(), oauth),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(read).not.toHaveBeenCalled();
    expect(oauth).not.toHaveBeenCalled();
    expect(effects.connect).not.toHaveBeenCalled();
  });

  it.each(['attendant', 'developer', null] as const)(
    'allows configured HTTP for %s',
    async (profession) => {
      const services = await testServices();
      const allowed = profileRecordSchema.parse({
        ...profile(profession),
        mcpServers: [
          {
            name: 'business',
            url: 'https://business.invalid/mcp',
          },
        ],
      });
      await expect(
        probeMcpServer(allowed, 'business', services.vault, vi.fn()),
      ).resolves.toMatchObject({ reachable: true });
      expect(effects.connect).toHaveBeenCalledOnce();
    },
  );

  it.each(['developer', null] as const)('preserves configured stdio for %s', async (profession) => {
    const services = await testServices();
    const allowed = profileRecordSchema.parse({
      ...profile(profession),
      mcpServers: [
        {
          name: 'local',
          transport: 'stdio',
          command: 'synthetic-no-process',
        },
      ],
    });
    await expect(probeMcpServer(allowed, 'local', services.vault, vi.fn())).resolves.toMatchObject({
      reachable: true,
    });
    expect(effects.connect).toHaveBeenCalledOnce();
  });

  it('keeps the profession guard even for an authenticated admin HTTP check', async () => {
    const services = await testServices();
    const saved = await services.profiles.createProfile({
      name: 'Attendant',
      instructions: 'Help.',
      mcpServers: [{ name: 'local', transport: 'stdio', command: 'must-not-run' }],
    });
    await services.store.db
      .update(profiles)
      .set({ professionId: 'attendant' })
      .where(eq(profiles.id, saved.id));
    const token = 'synthetic-owner-token-12345678901234567890';
    const app = createApp({ ...services, token, logger: false });
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/profiles/${saved.id}/mcp-servers/local/check`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(403);
      expect(effects.connect).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

describe('remote live profession ceiling', () => {
  it('refuses listing, shell and computer enqueue despite an existing machine ACL', async () => {
    const services = await testServices();
    const saved = await services.profiles.createProfile({
      name: 'Attendant',
      instructions: 'Help.',
    });
    const machine = await services.remote.create({
      name: 'Synthetic',
      allowedProfileIds: [saved.id],
    });
    await services.store.db
      .update(profiles)
      .set({ professionId: 'attendant' })
      .where(eq(profiles.id, saved.id));
    await expect(services.remote.listForProfile(saved.id)).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(
      services.remote.execute(saved.id, machine.id, { command: 'must-not-run' }),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      services.remote.executeComputer(saved.id, machine.id, { action: 'screenshot' }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(await services.store.db.select().from(remoteTasks)).toEqual([]);
    expect((await services.remote.list())[0]?.allowedProfileIds).toEqual([saved.id]);
    await expect(services.remote.listForProfile(randomUUID())).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it.each(['shell', 'computer'] as const)(
    'fails queued %s after live reclassification and dispatches the next allowed task',
    async (kind) => {
      const services = await testServices();
      const saved = await services.profiles.createProfile({
        name: 'Reclassified',
        instructions: 'Help.',
      });
      const legacy = await services.profiles.createProfile({
        name: 'Legacy',
        instructions: 'Help.',
      });
      // Legacy work was allowed when queued; first classification must constrain dispatch too.
      const machine = await services.remote.create({
        name: 'Synthetic',
        allowedProfileIds: [saved.id, legacy.id],
      });
      const forbiddenId = randomUUID();
      const allowedId = randomUUID();
      const now = new Date();
      await services.store.db.insert(remoteTasks).values([
        {
          id: forbiddenId,
          machineId: machine.id,
          profileId: saved.id,
          kind,
          command: 'forbidden',
          timeoutMs: 1000,
          status: 'queued',
          createdAt: now,
          updatedAt: now,
          payload: kind === 'computer' ? { action: 'screenshot' } : null,
        },
        {
          id: allowedId,
          machineId: machine.id,
          profileId: legacy.id,
          kind: 'shell',
          command: 'legacy',
          timeoutMs: 1000,
          status: 'queued',
          createdAt: new Date(now.getTime() + 1),
          updatedAt: now,
        },
      ]);
      await services.store.db
        .update(profiles)
        .set({ professionId: 'attendant' })
        .where(eq(profiles.id, saved.id));
      await expect(
        services.remote.poll(machine.id, `Bearer ${machine.token}`),
      ).resolves.toMatchObject({ task: { id: allowedId, command: 'legacy' } });
      const [denied] = await services.store.db
        .select()
        .from(remoteTasks)
        .where(eq(remoteTasks.id, forbiddenId));
      expect(denied).toMatchObject({
        status: 'failed',
        result: { stderr: 'Capability denied: remote.control' },
      });
      await expect(services.remote.poll(machine.id, 'Bearer invalid')).rejects.toMatchObject({
        statusCode: 401,
      });
    },
  );

  it('retains machine ACL checks for developer profiles', async () => {
    const services = await testServices();
    const saved = await services.profiles.createProfile({
      name: 'Developer',
      instructions: 'Help.',
    });
    await services.store.db
      .update(profiles)
      .set({ professionId: 'developer' })
      .where(eq(profiles.id, saved.id));
    const machine = await services.remote.create({ name: 'Private', allowedProfileIds: [] });
    expect(await services.remote.listForProfile(saved.id)).toEqual([]);
    await expect(
      services.remote.execute(saved.id, machine.id, { command: 'must-not-run' }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(await services.store.db.select().from(remoteTasks)).toEqual([]);
  });
});
