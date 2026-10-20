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
  expect(polled.task).toMatchObject({ command: 'printf hello' });
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
