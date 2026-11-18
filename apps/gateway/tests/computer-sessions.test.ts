import type { Run } from '@jian/contracts';
import type { Tool } from 'ai';
import { describe, expect, it } from 'vitest';
import { remoteTools } from '../src/agent/remote-tools.js';
import {
  nextInTurn,
  pointerColor,
  pointerLabel,
  TURN_GAP_MS,
  TURN_MAX_WAIT_MS,
  turnHolder,
} from '../src/remote/computer-sessions.js';
import { remoteTasks } from '../src/storage/schema.js';
import { testServices } from './helpers/services.js';

const CURRENT = 'computer-macos-v1,computer-result-v2,computer-sessions-v1';

type Services = Awaited<ReturnType<typeof testServices>>;
type Machine = { id: string; token: string };

/** One poll as the worker: the task it is handed, or none. */
async function poll(services: Services, machine: Machine, capabilities = CURRENT) {
  const polled = await services.remote.poll(
    machine.id,
    `Bearer ${machine.token}`,
    'darwin-arm64',
    capabilities,
    'unlocked',
  );
  return polled.task;
}

/** Polls as the worker until it is handed a task. */
async function nextTask(services: Services, machine: Machine, capabilities = CURRENT) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const task = await poll(services, machine, capabilities);
    if (task) return task;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('The worker was handed no task');
}

async function answer(services: Services, machine: Machine, taskId: string, computer: object) {
  await services.remote.complete(machine.id, taskId, `Bearer ${machine.token}`, {
    taskId,
    exitCode: 0,
    stdout: '',
    stderr: '',
    timedOut: false,
    computer,
  });
}

/** Waits until `count` tasks are queued, so a test knows the order they were asked in. */
async function queued(services: Services, count: number) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const rows = await services.store.db.select().from(remoteTasks);
    if (rows.filter((row) => row.status === 'queued').length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Fewer than ${count} tasks were queued`);
}

describe('what a worker is sent, by what it says it knows', () => {
  it('sends a session and asks for failure details only to a worker that knows them', async () => {
    const services = await testServices();
    const mia = await services.profiles.createProfile({ name: '  Mia  ', instructions: 'Help.' });
    const machine = await services.remote.create({ name: 'Studio' });

    // A worker from before either: the action as it always was, or it would refuse the task.
    await poll(services, machine, 'computer-macos-v1');
    const legacy = services.remote.executeComputer(
      mia.id,
      machine.id,
      { action: 'key', key: 'Return' },
      undefined,
      'conversation-1',
    );
    const old = await nextTask(services, machine, 'computer-macos-v1');
    expect(old.kind === 'computer' && old.computer).toEqual({ action: 'key', key: 'Return' });
    await answer(services, machine, old.id, { ok: true });
    await legacy;

    await poll(services, machine);
    const pending = services.remote.executeComputer(
      mia.id,
      machine.id,
      { action: 'key', key: 'Return' },
      undefined,
      'conversation-1',
    );
    const task = await nextTask(services, machine);
    expect(task.kind === 'computer' && task.computer).toEqual({
      action: 'key',
      key: 'Return',
      protocol: 2,
      session: { id: 'conversation-1', name: 'Mia', color: pointerColor(mia.id) },
    });
    await answer(services, machine, task.id, {
      ok: false,
      error: 'Accessibility is not granted.',
      code: 'perm_denied',
      delivery: 'not_delivered',
      permission: 'accessibility',
    });
    await expect(pending).resolves.toMatchObject({
      computer: { code: 'perm_denied', delivery: 'not_delivered', permission: 'accessibility' },
    });
  });

  it('tells the agent whether a failed action can be sent again', async () => {
    const services = await testServices();
    const machineId = '11111111-1111-4111-8111-111111111111';
    const asked: unknown[] = [];
    const failure = { ok: false, error: 'Key failed.', code: 'failed', delivery: 'uncertain' };
    let computer: object = failure;
    const remote = {
      list: async () => [{ id: machineId, name: 'Studio', online: true, platform: 'darwin-arm64' }],
      executeComputer: async (...args: unknown[]) => {
        asked.push(args[4]);
        return { exitCode: 1, stdout: '', stderr: '', timedOut: false, computer };
      },
    };
    const run = { id: 'run', profileId: 'profile', sessionId: 'conversation-1' } as unknown as Run;
    const tool = remoteTools(run, remote as never, services.store, machineId)
      .remote_computer as Tool;
    const press = () =>
      tool.execute?.(
        { machineId, action: 'key', key: 'Return', timeoutMs: 30_000 },
        { toolCallId: 'call', messages: [], context: {} },
      );

    await expect(press()).resolves.toMatchObject({ ok: false, code: 'failed', retry: 'unsafe' });
    // The action is asked for in the name of the conversation the run belongs to.
    expect(asked).toEqual(['conversation-1']);

    computer = { ...failure, code: 'screen_changed', delivery: 'not_delivered' };
    await expect(press()).resolves.toMatchObject({ code: 'screen_changed', retry: 'safe' });

    // An older worker says neither, and the agent is not told a guess.
    computer = { ok: false, error: 'Key failed.' };
    const unknown = await press();
    expect(unknown).not.toHaveProperty('retry');
    expect(unknown).not.toHaveProperty('code');
  });
});

describe('whose turn it is at a shared screen', () => {
  const at = (ms: number) => new Date(1_000_000 + ms);
  const task = (session: string | null, createdAt: number, action = 'left_click') => ({
    kind: 'computer' as const,
    payload: { action, ...(session ? { session: { id: session } } : {}) },
    createdAt: at(createdAt),
  });
  const served = (session: string, updatedAt: number, action = 'left_click') => ({
    ...task(session, 0, action),
    updatedAt: at(updatedAt),
  });
  const now = at(5_000).getTime();

  it('keeps the screen with the conversation that is in the middle of its steps', () => {
    const holder = turnHolder(served('a', 4_000), now);
    expect(holder).toBe('a');
    const other = task('b', 3_000);
    const mine = task('a', 4_500);
    expect(nextInTurn([other, mine], holder, now)).toBe(mine);
    // With nothing of its own queued, the holder is thinking: the other one waits.
    expect(nextInTurn([other], holder, now)).toBeUndefined();
  });

  it('lets the other one in once the holder stops, says it is done, or it has waited enough', () => {
    const other = task('b', 3_000);
    expect(turnHolder(served('a', 4_000), at(4_000 + TURN_GAP_MS + 1).getTime())).toBeNull();
    expect(turnHolder(served('a', 4_000, 'end_session'), now)).toBeNull();
    expect(nextInTurn([other], null, now)).toBe(other);

    const late = at(3_000 + TURN_MAX_WAIT_MS).getTime();
    expect(nextInTurn([other, task('a', 9_000)], 'a', late)).toBe(other);
  });

  it('never holds back what does not touch the screen, or a worker without sessions', () => {
    const shell = { kind: 'shell' as const, payload: null, createdAt: at(4_000) };
    expect(nextInTurn([task('b', 3_000), shell], 'a', now)).toBe(shell);
    const unnamed = task(null, 3_000);
    expect(nextInTurn([unnamed], 'a', now)).toBe(unnamed);
    expect(turnHolder({ ...unnamed, updatedAt: at(4_000) }, now)).toBeNull();
  });

  it('serves a conversation its next step before another one that asked first', async () => {
    const services = await testServices();
    const mia = await services.profiles.createProfile({ name: 'Mia', instructions: 'Help.' });
    const rex = await services.profiles.createProfile({ name: 'Rex', instructions: 'Help.' });
    const machine = await services.remote.create({ name: 'Studio' });
    await poll(services, machine);
    const act = (profileId: string, session: string, key: string) =>
      services.remote.executeComputer(
        profileId,
        machine.id,
        { action: 'key', key },
        undefined,
        session,
      );
    const sessionOf = (handed: Awaited<ReturnType<typeof nextTask>>) =>
      handed.kind === 'computer' ? handed.computer.session?.id : undefined;

    const first = act(mia.id, 'a', 'Tab');
    const one = await nextTask(services, machine);
    await answer(services, machine, one.id, { ok: true });
    await first;

    // Rex asks first, but Mia is between two steps of the same task on the screen.
    const waiting = act(rex.id, 'b', 'Escape');
    await queued(services, 1);
    expect(await poll(services, machine)).toBeNull();
    const second = act(mia.id, 'a', 'Return');
    await queued(services, 2);
    const two = await nextTask(services, machine);
    expect(sessionOf(two)).toBe('a');
    await answer(services, machine, two.id, { ok: true });
    await second;

    // Mia says she is done, and the screen is Rex's at once.
    const done = services.remote.executeComputer(
      mia.id,
      machine.id,
      { action: 'end_session' },
      undefined,
      'a',
    );
    const three = await nextTask(services, machine);
    expect(sessionOf(three)).toBe('a');
    await answer(services, machine, three.id, { ok: true });
    await done;
    const four = await nextTask(services, machine);
    expect(sessionOf(four)).toBe('b');
    await answer(services, machine, four.id, { ok: true });
    await waiting;
  });
});

describe('how a pointer is told apart', () => {
  it('gives an agent one colour, and a label that fits beside a pointer', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    expect(pointerColor(id)).toMatch(/^#[0-9a-f]{6}$/);
    expect(pointerColor(id)).toBe(pointerColor(id));
    expect(pointerLabel('  Mia ')).toBe('Mia');
    expect(pointerLabel('   ')).toBe('Agent');
    // Cut between characters: half an emoji would not survive the trip to the helper.
    const long = pointerLabel('🦊'.repeat(40));
    expect(long).toBe('🦊'.repeat(20));
  });
});
