import type { Run } from '@jian/contracts';
import type { Tool } from 'ai';
import { expect, it } from 'vitest';
import { remoteTools } from '../src/agent/remote-tools.js';
import { createApp } from '../src/app.js';
import { testServices } from './helpers/services.js';

it('lets every agent use every machine, and runs a task through the worker', async () => {
  const services = await testServices();
  const owner = await services.profiles.createProfile({ name: 'Owner', instructions: 'Help.' });
  const other = await services.profiles.createProfile({ name: 'Other', instructions: 'Help.' });
  const created = await services.remote.create({ name: 'MacBook' });

  expect(created.token).toHaveLength(43);

  // Two agents, one machine: each runs a command there, with nothing granted first.
  for (const [profile, text] of [
    [owner, 'hello'],
    [other, 'again'],
  ] as const) {
    const pending = services.remote.execute(profile.id, created.id, { command: `printf ${text}` });
    let polled: Awaited<ReturnType<typeof services.remote.poll>> = { task: null };
    for (let attempt = 0; attempt < 20 && !polled.task; attempt++) {
      polled = await services.remote.poll(created.id, `Bearer ${created.token}`, 'darwin-arm64');
      if (!polled.task) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(polled.task).toMatchObject({ kind: 'shell', command: `printf ${text}` });
    if (!polled.task) throw new Error('Worker did not receive the task');
    const taskId = polled.task.id;
    await services.remote.complete(created.id, taskId, `Bearer ${created.token}`, {
      taskId,
      exitCode: 0,
      stdout: text,
      stderr: '',
      timedOut: false,
    });
    await expect(pending).resolves.toMatchObject({ taskId, exitCode: 0, stdout: text });
  }

  await expect(
    services.remote.execute(owner.id, '00000000-0000-4000-8000-000000000000', {
      command: 'whoami',
    }),
  ).rejects.toMatchObject({ statusCode: 404 });
  await expect(services.remote.poll(created.id, 'Bearer invalid', undefined)).rejects.toMatchObject(
    { statusCode: 401 },
  );
  await services.remote.poll(created.id, `Bearer ${created.token}`, 'win32-x64');
  await expect(services.remote.list()).resolves.toMatchObject([
    { id: created.id, platform: 'win32-x64' },
  ]);
});

it('shows a worker offline as soon as it says it is stopping', async () => {
  const services = await testServices();
  const created = await services.remote.create({ name: 'MacBook' });

  await services.remote.poll(created.id, `Bearer ${created.token}`, 'darwin-arm64');
  expect((await services.remote.list())[0]?.online).toBe(true);

  await expect(services.remote.disconnect(created.id, 'Bearer invalid')).rejects.toMatchObject({
    statusCode: 401,
  });
  await services.remote.disconnect(created.id, `Bearer ${created.token}`);
  expect((await services.remote.list())[0]?.online).toBe(false);

  // The next poll brings it back.
  await services.remote.poll(created.id, `Bearer ${created.token}`, 'darwin-arm64');
  expect((await services.remote.list())[0]?.online).toBe(true);
});

/** Runs `body` on a gateway stamped with `version`, as its image would be. */
async function onRelease<T>(version: string, body: () => Promise<T>): Promise<T> {
  const previous = process.env.JIAN_VERSION;
  process.env.JIAN_VERSION = version;
  try {
    return await body();
  } finally {
    if (previous === undefined) delete process.env.JIAN_VERSION;
    else process.env.JIAN_VERSION = previous;
  }
}

/** Polls as the worker until it is handed a task. */
async function nextTask(
  remote: Awaited<ReturnType<typeof testServices>>['remote'],
  machine: { id: string; token: string },
  capabilities: string,
  version: string,
) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const polled = await remote.poll(
      machine.id,
      `Bearer ${machine.token}`,
      'darwin-arm64',
      capabilities,
      'unlocked',
      version,
    );
    if (polled.task) return polled.task;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('The worker was handed no task');
}

it('refuses agents a worker on another release, and hands that worker only its update', async () => {
  await onRelease('1.2.0', async () => {
    const services = await testServices();
    const owner = await services.profiles.createProfile({ name: 'Owner', instructions: 'Help.' });
    const machine = await services.remote.create({ name: 'MacBook' });
    const capabilities = 'computer-macos-v1,update-npm';

    await services.remote.poll(
      machine.id,
      `Bearer ${machine.token}`,
      'darwin-arm64',
      capabilities,
      'unlocked',
      '1.1.4',
    );
    expect((await services.remote.list())[0]).toMatchObject({
      version: '1.1.4',
      outdated: true,
      updatable: true,
    });
    await expect(
      services.remote.execute(owner.id, machine.id, { command: 'whoami' }),
    ).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('Update') });
    await expect(
      services.remote.executeComputer(owner.id, machine.id, { action: 'screenshot' }),
    ).rejects.toMatchObject({ statusCode: 409 });

    const updating = services.remote.update(owner.id, machine.id);
    const task = await nextTask(services.remote, machine, capabilities, '1.1.4');
    expect(task).toMatchObject({ kind: 'update', update: { version: '1.2.0' } });
    await services.remote.complete(machine.id, task.id, `Bearer ${machine.token}`, {
      taskId: task.id,
      exitCode: 0,
      stdout: 'Updated Jian Remote from 1.1.4 to 1.2.0.',
      stderr: '',
      update: { from: '1.1.4', to: '1.2.0' },
    });
    await expect(updating).resolves.toEqual({
      ok: true,
      from: '1.1.4',
      to: '1.2.0',
      message: 'Updated Jian Remote from 1.1.4 to 1.2.0.',
    });

    // Back on the gateway's release, it serves agents again.
    await services.remote.poll(
      machine.id,
      `Bearer ${machine.token}`,
      'darwin-arm64',
      capabilities,
      'unlocked',
      '1.2.7',
    );
    expect((await services.remote.list())[0]?.outdated).toBe(false);
    const pending = services.remote.execute(owner.id, machine.id, { command: 'whoami' });
    const shell = await nextTask(services.remote, machine, capabilities, '1.2.7');
    expect(shell).toMatchObject({ kind: 'shell', command: 'whoami' });
    await services.remote.complete(machine.id, shell.id, `Bearer ${machine.token}`, {
      taskId: shell.id,
      exitCode: 0,
      stdout: 'maya',
      stderr: '',
    });
    await expect(pending).resolves.toMatchObject({ exitCode: 0, stdout: 'maya' });
  });
});

it('updates only a machine whose worker can update itself, and only while it is online', async () => {
  await onRelease('1.2.0', async () => {
    const services = await testServices();
    const machine = await services.remote.create({ name: 'Linux box' });

    await expect(services.remote.update(null, machine.id)).rejects.toMatchObject({
      statusCode: 503,
    });
    // Installed some other way: it does not offer update-npm.
    await services.remote.poll(
      machine.id,
      `Bearer ${machine.token}`,
      'linux-x64',
      '',
      'unknown',
      '1.1.0',
    );
    expect((await services.remote.list())[0]?.updatable).toBe(false);
    await expect(services.remote.update(null, machine.id)).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('jian-remote update'),
    });
  });
});

it('lets only the owner update a machine from the panel, as a task of no agent', async () => {
  await onRelease('1.2.0', async () => {
    const services = await testServices();
    const machine = await services.remote.create({ name: 'MacBook' });
    const token = 'host-admin-token-for-test-1234567890-verysecret';
    const app = createApp({ ...services, token, logger: false });
    try {
      await services.remote.poll(
        machine.id,
        `Bearer ${machine.token}`,
        'darwin-arm64',
        'update-npm',
        'unlocked',
        '1.1.0',
      );
      const url = `/v1/remote/machines/${machine.id}/update`;
      expect((await app.inject({ method: 'POST', url })).statusCode).toBe(401);
      // The machine's own worker token is not the owner's.
      const asWorker = await app.inject({
        method: 'POST',
        url,
        headers: { authorization: `Bearer ${machine.token}` },
      });
      expect(asWorker.statusCode).toBe(401);

      const response = app.inject({
        method: 'POST',
        url,
        headers: { authorization: `Bearer ${token}` },
      });
      const task = await nextTask(services.remote, machine, 'update-npm', '1.1.0');
      await services.remote.complete(machine.id, task.id, `Bearer ${machine.token}`, {
        taskId: task.id,
        exitCode: 1,
        stdout: '',
        stderr: 'npm ERR! network unreachable',
      });
      const answered = await response;
      expect(answered.statusCode).toBe(200);
      expect(answered.json()).toEqual({
        ok: false,
        from: '1.1.0',
        to: null,
        message: 'npm ERR! network unreachable',
      });
    } finally {
      await app.close();
    }
  });
});

it('keeps a conversation bound to one machine from updating another', async () => {
  const services = await testServices();
  const updated: string[] = [];
  const remote = {
    list: async () => [],
    execute: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
    executeComputer: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
    update: async (_profile: string | null, machineId: string) => {
      updated.push(machineId);
      return { ok: true, from: '1.1.0', to: '1.2.0', message: 'Updated.' };
    },
  };
  const bound = '11111111-1111-4111-8111-111111111111';
  const other = '22222222-2222-4222-8222-222222222222';
  const run = { id: 'run', profileId: 'profile', sessionId: 'session' } as unknown as Run;
  const tools = remoteTools(run, remote as never, services.store, bound);
  const update = tools.update_remote_machine as Tool<{ machineId: string }>;
  const call = (machineId: string) =>
    update.execute?.({ machineId }, { toolCallId: 'call', messages: [], context: {} });

  await expect(call(other)).rejects.toMatchObject({ statusCode: 403 });
  await expect(call(bound)).resolves.toMatchObject({ ok: true });
  expect(updated).toEqual([bound]);
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
  const created = await services.remote.create({ name: 'MacBook' });

  await services.remote.poll(
    created.id,
    `Bearer ${created.token}`,
    'darwin-arm64',
    'computer-macos-v1',
    'unlocked',
  );
  const listed = await services.remote.list();
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

it('keeps a locked Mac online and still queues Computer Use and shell (no soft 409)', async () => {
  const services = await testServices();
  const owner = await services.profiles.createProfile({ name: 'Owner', instructions: 'Help.' });
  const created = await services.remote.create({ name: 'Locked Mac' });

  await services.remote.poll(
    created.id,
    `Bearer ${created.token}`,
    'darwin-arm64',
    'computer-macos-v1',
    'locked',
  );
  const listed = await services.remote.list();
  expect(listed[0]).toMatchObject({ online: true, uiState: 'locked' });

  const click = services.remote.executeComputer(owner.id, created.id, {
    action: 'left_click',
    coordinate: [1, 1],
  });
  let polledClick: Awaited<ReturnType<typeof services.remote.poll>> = { task: null };
  for (let attempt = 0; attempt < 20 && !polledClick.task; attempt++) {
    polledClick = await services.remote.poll(
      created.id,
      `Bearer ${created.token}`,
      'darwin-arm64',
      'computer-macos-v1',
      'locked',
    );
    if (!polledClick.task) await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(polledClick.task).toMatchObject({
    kind: 'computer',
    computer: { action: 'left_click', coordinate: [1, 1] },
  });
  if (!polledClick.task) throw new Error('Worker did not receive the click task');
  await services.remote.complete(created.id, polledClick.task.id, `Bearer ${created.token}`, {
    taskId: polledClick.task.id,
    exitCode: 0,
    stdout: '',
    stderr: '',
    timedOut: false,
    computer: { ok: true },
  });
  await expect(click).resolves.toMatchObject({ exitCode: 0, computer: { ok: true } });

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
  const created = await services.remote.create({ name: 'Desk Linux' });

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
  const created = await services.remote.create({ name: 'Desk Win' });

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
  const created = await services.remote.create({ name: 'Shot' });
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
