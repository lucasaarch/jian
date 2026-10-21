import { expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { testServices } from './helpers/services.js';

it('shares machines per profile and executes an authorized worker task', async () => {
  const services = await testServices();
  const owner = await services.profiles.createProfile({ name: 'Owner', instructions: 'Help.' });
  const other = await services.profiles.createProfile({ name: 'Other', instructions: 'Help.' });
  const created = await services.remote.create({ name: 'MacBook', allowedProfileIds: [owner.id] });

  expect(created.token).toHaveLength(43);
  expect(await services.remote.listForProfile(owner.id)).toHaveLength(1);
  expect(await services.remote.listForProfile(other.id)).toEqual([]);
  await expect(
    services.remote.execute(other.id, created.id, { command: 'whoami' }),
  ).rejects.toMatchObject({ statusCode: 403 });

  const pending = services.remote.execute(owner.id, created.id, { command: 'printf hello' });
  let polled: Awaited<ReturnType<typeof services.remote.poll>> = { task: null };
  for (let attempt = 0; attempt < 20 && !polled.task; attempt++) {
    polled = await services.remote.poll(created.id, `Bearer ${created.token}`, 'darwin-arm64');
    if (!polled.task) await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(polled.task).toMatchObject({ kind: 'shell', command: 'printf hello' });
  if (!polled.task) throw new Error('Worker did not receive the task');
  const taskId = polled.task.id;
  await services.remote.complete(created.id, taskId, `Bearer ${created.token}`, {
    taskId,
    exitCode: 0,
    stdout: 'hello',
    stderr: '',
    timedOut: false,
  });
  await expect(pending).resolves.toMatchObject({ taskId, exitCode: 0, stdout: 'hello' });

  await services.remote.setAccess(created.id, { allowedProfileIds: [other.id] });
  await expect(
    services.remote.execute(owner.id, created.id, { command: 'whoami' }),
  ).rejects.toMatchObject({ statusCode: 403 });
  await expect(services.remote.poll(created.id, 'Bearer invalid', undefined)).rejects.toMatchObject(
    { statusCode: 401 },
  );
  await services.remote.poll(created.id, `Bearer ${created.token}`, 'win32-x64');
  await expect(services.remote.list()).resolves.toMatchObject([
    { id: created.id, platform: 'win32-x64' },
  ]);
});

it('serves the worker script without authentication so install one-liners can download it', async () => {
  const services = await testServices();
  const app = createApp({
    ...services,
    token: 'host-admin-token-for-test-1234567890-verysecret',
    logger: false,
  });
  try {
    const response = await app.inject({ url: '/jian-remote.mjs' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/javascript/);
    expect(response.body).toContain('Jian Remote worker');
    expect(response.body).toContain('--token');
    expect(response.body).toContain('configure [--gateway');
    expect(response.body).toContain('update [--version');
  } finally {
    await app.close();
  }
});

it('stamps the served worker PACKAGE_VERSION to JIAN_VERSION for major.minor compatibility', async () => {
  const previous = process.env.JIAN_VERSION;
  process.env.JIAN_VERSION = '0.6.0';
  const services = await testServices();
  const app = createApp({
    ...services,
    token: 'host-admin-token-for-test-1234567890-verysecret',
    logger: false,
  });
  try {
    const health = await app.inject({ url: '/health' });
    expect(health.json()).toMatchObject({ status: 'ok', service: 'jian', version: '0.6.0' });
    const response = await app.inject({ url: '/jian-remote.mjs' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("export const PACKAGE_VERSION = '0.6.0'");
  } finally {
    await app.close();
    if (previous === undefined) delete process.env.JIAN_VERSION;
    else process.env.JIAN_VERSION = previous;
  }
});

it('serves automatic worker updates only to the matching authenticated machine', async () => {
  const services = await testServices();
  const created = await services.remote.create({ name: 'Updater' });
  const app = createApp({
    ...services,
    token: 'host-admin-token-for-test-1234567890-verysecret',
    logger: false,
  });
  try {
    const denied = await app.inject({ url: `/v1/remote/worker/${created.id}/update` });
    expect(denied.statusCode).toBe(401);
    const accepted = await app.inject({
      url: `/v1/remote/worker/${created.id}/update`,
      headers: { authorization: `Bearer ${created.token}` },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.headers.etag).toMatch(/^"[a-f0-9]{64}"$/);
    expect(accepted.body).toContain('updateIfNeeded');
    const unchanged = await app.inject({
      url: `/v1/remote/worker/${created.id}/update`,
      headers: { authorization: `Bearer ${created.token}`, 'if-none-match': accepted.headers.etag },
    });
    expect(unchanged.statusCode).toBe(304);
  } finally {
    await app.close();
  }
});

it('rotates the worker token and rejects the previous one', async () => {
  const services = await testServices();
  const created = await services.remote.create({ name: 'Rotate me' });
  const app = createApp({
    ...services,
    token: 'host-admin-token-for-test-1234567890-verysecret',
    logger: false,
  });
  try {
    const before = await app.inject({
      url: `/v1/remote/worker/${created.id}/tasks/next`,
      headers: { authorization: `Bearer ${created.token}` },
    });
    expect(before.statusCode).toBe(200);

    const rotated = await app.inject({
      method: 'POST',
      url: `/v1/remote/machines/${created.id}/rotate`,
      headers: { authorization: 'Bearer host-admin-token-for-test-1234567890-verysecret' },
    });
    expect(rotated.statusCode).toBe(200);
    const body = rotated.json() as { id: string; token: string; name: string };
    expect(body.id).toBe(created.id);
    expect(body.token).toHaveLength(43);
    expect(body.token).not.toBe(created.token);

    const stale = await app.inject({
      url: `/v1/remote/worker/${created.id}/tasks/next`,
      headers: { authorization: `Bearer ${created.token}` },
    });
    expect(stale.statusCode).toBe(401);

    const fresh = await app.inject({
      url: `/v1/remote/worker/${created.id}/tasks/next`,
      headers: { authorization: `Bearer ${body.token}` },
    });
    expect(fresh.statusCode).toBe(200);
    expect(fresh.json()).toEqual({ task: null });
  } finally {
    await app.close();
  }
});

it('authenticates the worker API with its machine token, not the gateway admin token', async () => {
  const services = await testServices();
  const created = await services.remote.create({ name: 'Worker test' });
  const app = createApp({
    ...services,
    token: 'host-admin-token-for-test-1234567890-verysecret',
    logger: false,
  });
  try {
    const denied = await app.inject({ url: `/v1/remote/worker/${created.id}/tasks/next` });
    expect(denied.statusCode).toBe(401);
    const accepted = await app.inject({
      url: `/v1/remote/worker/${created.id}/tasks/next`,
      headers: { authorization: `Bearer ${created.token}` },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual({ task: null });
  } finally {
    await app.close();
  }
});

it('queues computer-use tasks when the worker advertises computer-macos-v1', async () => {
  const services = await testServices();
  const owner = await services.profiles.createProfile({ name: 'Owner', instructions: 'Help.' });
  const created = await services.remote.create({ name: 'MacBook', allowedProfileIds: [owner.id] });

  await services.remote.poll(
    created.id,
    `Bearer ${created.token}`,
    'darwin-arm64',
    'computer-macos-v1',
    'unlocked',
  );
  const listed = await services.remote.listForProfile(owner.id);
  expect(listed[0]?.capabilities).toContain('computer-macos-v1');
  expect(listed[0]?.uiState).toBe('unlocked');
  expect(listed[0]?.online).toBe(true);

  const pending = services.remote.executeComputer(owner.id, created.id, {
    action: 'mouse_move',
    coordinate: [10, 20],
  });
  let polled: Awaited<ReturnType<typeof services.remote.poll>> = { task: null };
  for (let attempt = 0; attempt < 20 && !polled.task; attempt++) {
    polled = await services.remote.poll(
      created.id,
      `Bearer ${created.token}`,
      'darwin-arm64',
      'computer-macos-v1',
      'unlocked',
    );
    if (!polled.task) await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(polled.task).toMatchObject({
    kind: 'computer',
    computer: { action: 'mouse_move', coordinate: [10, 20] },
  });
  if (!polled.task) throw new Error('Worker did not receive the computer task');
  const taskId = polled.task.id;
  await services.remote.complete(created.id, taskId, `Bearer ${created.token}`, {
    taskId,
    exitCode: 0,
    stdout: '',
    stderr: '',
    timedOut: false,
    computer: { ok: true },
  });
  await expect(pending).resolves.toMatchObject({ taskId, exitCode: 0, computer: { ok: true } });
});

it('keeps a locked Mac online but refuses Computer Use with a clear error', async () => {
  const services = await testServices();
  const owner = await services.profiles.createProfile({ name: 'Owner', instructions: 'Help.' });
  const created = await services.remote.create({
    name: 'Locked Mac',
    allowedProfileIds: [owner.id],
  });

  await services.remote.poll(
    created.id,
    `Bearer ${created.token}`,
    'darwin-arm64',
    'computer-macos-v1',
    'locked',
  );
  const listed = await services.remote.listForProfile(owner.id);
  expect(listed[0]).toMatchObject({ online: true, uiState: 'locked' });

  await expect(
    services.remote.executeComputer(owner.id, created.id, { action: 'screenshot' }),
  ).rejects.toMatchObject({
    statusCode: 409,
    message: expect.stringMatching(/locked/i),
  });

  const shell = services.remote.execute(owner.id, created.id, { command: 'printf ok' });
  let polled: Awaited<ReturnType<typeof services.remote.poll>> = { task: null };
  for (let attempt = 0; attempt < 20 && !polled.task; attempt++) {
    polled = await services.remote.poll(
      created.id,
      `Bearer ${created.token}`,
      'darwin-arm64',
      'computer-macos-v1',
      'locked',
    );
    if (!polled.task) await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(polled.task).toMatchObject({ kind: 'shell', command: 'printf ok' });
  if (!polled.task) throw new Error('Worker did not receive the shell task');
  await services.remote.complete(created.id, polled.task.id, `Bearer ${created.token}`, {
    taskId: polled.task.id,
    exitCode: 0,
    stdout: 'ok',
    stderr: '',
    timedOut: false,
  });
  await expect(shell).resolves.toMatchObject({ exitCode: 0, stdout: 'ok' });
});

it('queues computer-use tasks for Linux workers advertising computer-linux-v1', async () => {
  const services = await testServices();
  const owner = await services.profiles.createProfile({ name: 'Owner', instructions: 'Help.' });
  const created = await services.remote.create({
    name: 'Desk Linux',
    allowedProfileIds: [owner.id],
  });

  await services.remote.poll(
    created.id,
    `Bearer ${created.token}`,
    'linux-x64',
    'computer-linux-v1',
  );
  const pending = services.remote.executeComputer(owner.id, created.id, {
    action: 'screenshot',
  });
  let polled: Awaited<ReturnType<typeof services.remote.poll>> = { task: null };
  for (let attempt = 0; attempt < 20 && !polled.task; attempt++) {
    polled = await services.remote.poll(
      created.id,
      `Bearer ${created.token}`,
      'linux-x64',
      'computer-linux-v1',
    );
    if (!polled.task) await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(polled.task).toMatchObject({ kind: 'computer', computer: { action: 'screenshot' } });
  if (!polled.task) throw new Error('Worker did not receive the computer task');
  const taskId = polled.task.id;
  await services.remote.complete(created.id, taskId, `Bearer ${created.token}`, {
    taskId,
    exitCode: 0,
    stdout: '',
    stderr: '',
    timedOut: false,
    computer: { ok: true, widthPx: 100, heightPx: 80 },
  });
  await expect(pending).resolves.toMatchObject({ taskId, exitCode: 0, computer: { ok: true } });
});

it('queues computer-use tasks for Windows workers advertising computer-windows-v1', async () => {
  const services = await testServices();
  const owner = await services.profiles.createProfile({ name: 'Owner', instructions: 'Help.' });
  const created = await services.remote.create({ name: 'Desk Win', allowedProfileIds: [owner.id] });

  await services.remote.poll(
    created.id,
    `Bearer ${created.token}`,
    'win32-x64',
    'computer-windows-v1',
  );
  const pending = services.remote.executeComputer(owner.id, created.id, {
    action: 'left_click',
    coordinate: [5, 5],
  });
  let polled: Awaited<ReturnType<typeof services.remote.poll>> = { task: null };
  for (let attempt = 0; attempt < 20 && !polled.task; attempt++) {
    polled = await services.remote.poll(
      created.id,
      `Bearer ${created.token}`,
      'win32-x64',
      'computer-windows-v1',
    );
    if (!polled.task) await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(polled.task).toMatchObject({
    kind: 'computer',
    computer: { action: 'left_click', coordinate: [5, 5] },
  });
  if (!polled.task) throw new Error('Worker did not receive the computer task');
  const taskId = polled.task.id;
  await services.remote.complete(created.id, taskId, `Bearer ${created.token}`, {
    taskId,
    exitCode: 0,
    stdout: '',
    stderr: '',
    timedOut: false,
    computer: { ok: true },
  });
  await expect(pending).resolves.toMatchObject({ taskId, exitCode: 0, computer: { ok: true } });
});

it('accepts a large remote result that previously hit the default 256 KiB body limit', async () => {
  const services = await testServices();
  const owner = await services.profiles.createProfile({ name: 'Owner', instructions: 'Help.' });
  const created = await services.remote.create({ name: 'Shot', allowedProfileIds: [owner.id] });
  const pending = services.remote.execute(owner.id, created.id, { command: 'printf shot' });
  let polled: Awaited<ReturnType<typeof services.remote.poll>> = { task: null };
  for (let attempt = 0; attempt < 20 && !polled.task; attempt++) {
    polled = await services.remote.poll(created.id, `Bearer ${created.token}`, 'darwin-arm64');
    if (!polled.task) await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (!polled.task) throw new Error('Worker did not receive the task');
  const taskId = polled.task.id;
  const stdout = 'A'.repeat(300_000);
  const app = createApp({
    ...services,
    token: 'host-admin-token-for-test-1234567890-verysecret',
    logger: false,
  });
  try {
    const response = await app.inject({
      method: 'POST',
      url: `/v1/remote/worker/${created.id}/tasks/${taskId}/result`,
      headers: {
        authorization: `Bearer ${created.token}`,
        'content-type': 'application/json',
      },
      payload: { taskId, exitCode: 0, stdout, stderr: '', timedOut: false },
    });
    expect(response.statusCode).toBe(200);
    await expect(pending).resolves.toMatchObject({ taskId, exitCode: 0, stdout });
  } finally {
    await app.close();
  }
});
