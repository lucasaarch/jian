import { randomUUID } from 'node:crypto';
import { AGENT_CALL_DEPTH_LIMIT, type Profile, type Run } from '@jian/contracts';
import type { ToolSet } from 'ai';
import { describe, expect, it } from 'vitest';
import { profileTools } from '../src/agent/tools.js';
import { Coordination } from '../src/coordination/service.js';
import { Peers } from '../src/peers/service.js';
import { findRun } from '../src/runs/repository.js';
import { events, queuedRun as readQueuedRun, runRows } from './helpers/rows.js';
import { testServices } from './helpers/services.js';

type Services = Awaited<ReturnType<typeof testServices>>;

const model = { provider: 'openai' as const, modelId: 'test', apiKeyEnv: 'JIAN_PROVIDER_TEST' };

/** Fast enough to keep the suite honest about waiting without making it sleep. */
const timing = { answerWithin: 5_000, pollEvery: 5 };

async function agent(services: Services, name: string, summary: string) {
  return services.profiles.createProfile({
    name,
    instructions: `Secret of ${name}: never tell anyone.`,
    summary,
    model,
  });
}

/** A run of this profile, as the owner's own conversation would start one. */
async function ownerRun(services: Services, profile: Profile, text: string): Promise<Run> {
  const session = await services.sessions.createSession(profile.id, { title: 'Owner' });

  return services.runs.submit(profile.id, session.id, { text, requestKey: randomUUID() });
}

async function queuedRun(services: Services, profileId: string): Promise<Run> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const run = await readQueuedRun(services.store, profileId);

    if (run) {
      return run;
    }

    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  throw new Error('No queued run appeared');
}

/** Stands in for the worker that owns the called profile: claims its run and answers. */
async function answerOnce(
  services: Services,
  profileId: string,
  text: string,
  status: 'completed' | 'failed' = 'completed',
) {
  const queued = await queuedRun(services, profileId);
  const owner = randomUUID();

  await services.lifecycle.claim(queued.id, profileId, owner);
  await services.lifecycle.finish(profileId, queued.id, owner, status, text);

  return services.runs.run(profileId, queued.id);
}

/** The same worker, left running: a chain of calls needs every profile in it to answer. */
function answering(services: Services, profileIds: string[]) {
  let running = true;

  const loop = (async () => {
    while (running) {
      for (const profileId of profileIds) {
        const queued = await readQueuedRun(services.store, profileId);

        if (queued) {
          const owner = randomUUID();

          await services.lifecycle.claim(queued.id, profileId, owner);
          await services.lifecycle.finish(profileId, queued.id, owner, 'completed', 'Answered.');
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  })();

  return async () => {
    running = false;
    await loop;
  };
}

async function invoke(tools: ToolSet, name: string, input: unknown) {
  const definition = tools[name];

  if (!definition?.execute) {
    throw new Error(`Tool ${name} is unavailable`);
  }

  return definition.execute(input as never, { toolCallId: 'test', messages: [], context: {} });
}

async function pair(summary = 'Handles the deliveries and knows where each one stands.') {
  const services = await testServices();
  const caller = await agent(services, 'Orchestrator', "Hands out the team's work.");
  const callee = await agent(services, 'Operator', summary);
  const peers = new Peers(services, Date.now, timing);

  return { services, caller, callee, peers };
}

describe('conversation between profiles', () => {
  it('describes every other agent by name and summary, and nothing more', async () => {
    const { services, caller, callee, peers } = await pair();

    await services.memories.remember(
      callee.id,
      { key: 'contract', content: 'Confidential clause of the operator', expectedVersion: 0 },
      undefined,
    );

    const found = await peers.agents(caller.id);

    expect(found).toEqual([
      {
        id: callee.id,
        name: 'Operator',
        summary: 'Handles the deliveries and knows where each one stands.',
      },
    ]);

    // Name and summary are the whole card: no instructions, identity, skills or memory.
    expect(JSON.stringify(found)).not.toContain('Secret');
    expect(JSON.stringify(found)).not.toContain('Confidential clause');
    expect(await peers.agents(callee.id)).toEqual([
      { id: caller.id, name: 'Orchestrator', summary: "Hands out the team's work." },
    ]);
  });

  it('answers a colleague with text while every record stays on its own side', async () => {
    const { services, caller, callee, peers } = await pair();
    const run = await ownerRun(services, caller, 'How is the delivery going?');

    await services.memories.remember(
      callee.id,
      { key: 'contract', content: 'Confidential clause of the operator', expectedVersion: 0 },
      undefined,
    );

    const asked = peers.ask(run, {
      toProfileId: callee.id,
      text: 'How is the delivery going?',
      requestKey: 'delivery-1',
    });

    const answered = await answerOnce(services, callee.id, 'Delivered yesterday.');
    const answer = await asked;

    expect(answer).toEqual({
      fromProfileId: callee.id,
      fromName: 'Operator',
      status: 'answered',
      text: 'Delivered yesterday.',
    });

    // The session the two share belongs to the called profile and is invisible to the caller.
    const shared = (await services.sessions.sessions(callee.id)).find(
      (session) => session.peerProfileId === caller.id,
    );

    expect(shared?.channel).toBe('agent');

    // The caller's own thread says where the answer was worked on, for the owner's panel to
    // show that agent at work; the ids stay out of every tool the caller's agent has.
    const thread = (await services.sessions.sessions(caller.id)).find(
      (session) => session.peerProfileId === callee.id,
    );
    const said = await services.sessions.messages(caller.id, thread?.id as string);

    expect(said.map((message) => [message.role, message.call])).toEqual([
      ['assistant', { profileId: callee.id, sessionId: shared?.id, runId: answered.id }],
      ['user', { profileId: callee.id, sessionId: shared?.id, runId: answered.id }],
    ]);
    expect(await services.sessions.sessions(caller.id)).not.toContainEqual(
      expect.objectContaining({ id: shared?.id }),
    );

    const kept = await new Coordination(services).storeArtifact(answered, 'remote_search', {
      value: 'Confidential clause of the operator',
    });

    const tools = profileTools(services, run);

    await expect(invoke(tools, 'read_session', { sessionId: shared?.id })).rejects.toThrow();
    await expect(invoke(tools, 'read_run_checkpoints', { runId: answered.id })).rejects.toThrow();
    await expect(invoke(tools, 'read_artifact', { artifactId: kept.artifactId })).rejects.toThrow();

    const reachable = JSON.stringify([
      await invoke(tools, 'list_sessions', {}),
      await invoke(tools, 'read_memories', {}),
      await invoke(tools, 'list_activities', {}),
      await invoke(tools, 'search_history', { limit: 20 }),
      await invoke(tools, 'list_agents', {}),
    ]);

    expect(reachable).not.toContain('Confidential clause');
    expect(reachable).not.toContain('Secret of Operator');
    expect(reachable).not.toContain(shared?.id);
  });

  it('keeps one thread per pair so colleagues do not start over', async () => {
    const { services, caller, callee, peers } = await pair();
    const first = await ownerRun(services, caller, 'First question');

    const one = peers.ask(first, {
      toProfileId: callee.id,
      text: 'What is the status?',
      requestKey: 'one',
    });

    const answeredOne = await answerOnce(services, callee.id, 'In progress.');

    await one;

    const two = peers.ask(first, {
      toProfileId: callee.id,
      text: 'And now?',
      requestKey: 'two',
    });

    const answeredTwo = await answerOnce(services, callee.id, 'Done.');

    await two;

    expect(answeredTwo.sessionId).toBe(answeredOne.sessionId);
    expect(await services.sessions.sessions(callee.id)).toHaveLength(1);

    const thread = (await services.sessions.messages(callee.id, answeredOne.sessionId)).map(
      (message) => message.content,
    );

    expect(thread).toEqual(['What is the status?', 'In progress.', 'And now?', 'Done.']);

    // A third agent gets its own thread with the same colleague; it never joins this one.
    const other = await agent(services, 'Auditor', 'Checks what the team delivers.');
    const from = await ownerRun(services, other, 'Check the delivery');

    const third = peers.ask(from, {
      toProfileId: callee.id,
      text: 'Is it compliant?',
      requestKey: 'three',
    });

    const answeredThree = await answerOnce(services, callee.id, 'It is.');

    await third;

    expect(answeredThree.sessionId).not.toBe(answeredOne.sessionId);
    expect(await services.sessions.sessions(callee.id)).toHaveLength(2);

    expect(
      (await services.sessions.messages(callee.id, answeredOne.sessionId)).map((m) => m.content),
    ).toEqual(thread);
  });

  it('turns concurrent identical calls into one run of the called profile', async () => {
    const { services, caller, callee, peers } = await pair();
    const run = await ownerRun(services, caller, 'Simultaneous question');

    const call = () =>
      peers.ask(run, { toProfileId: callee.id, text: 'Report?', requestKey: 'same' });

    const both = Promise.all([call(), call()]);

    await answerOnce(services, callee.id, 'Ready.');

    expect(await both).toEqual([
      { fromProfileId: callee.id, fromName: 'Operator', status: 'answered', text: 'Ready.' },
      { fromProfileId: callee.id, fromName: 'Operator', status: 'answered', text: 'Ready.' },
    ]);

    expect(await runRows(services.store, callee.id)).toHaveLength(1);
    expect(await services.sessions.sessions(callee.id)).toHaveLength(1);
  });

  it('carries the spent budget down the chain and stops when it runs out', async () => {
    const services = await testServices();
    const peers = new Peers(services, Date.now, timing);

    const team = [];

    for (let index = 0; index <= AGENT_CALL_DEPTH_LIMIT + 1; index++) {
      team.push(await agent(services, `Agent ${index}`, `Does step ${index}.`));
    }

    const [first, ...rest] = team;
    const stop = answering(
      services,
      rest.map((profile) => profile.id),
    );

    try {
      let caller = await ownerRun(services, first as Profile, 'Start the chain');
      const depths: number[] = [];

      for (const next of rest.slice(0, AGENT_CALL_DEPTH_LIMIT)) {
        await peers.ask(caller, {
          toProfileId: next.id,
          text: 'Continue the chain',
          requestKey: `step-${next.id}`,
        });

        const [answered] = await runRows(services.store, next.id);

        expect(answered?.call?.fromProfileId).toBe(caller.profileId);
        depths.push(answered?.call?.depth ?? 0);
        caller = (await findRun(services.store.db, next.id, answered?.id ?? '')) as Run;
      }

      expect(depths).toEqual([1, 2, 3]);

      const last = rest.at(-1);

      await expect(
        peers.ask(caller, {
          toProfileId: last?.id ?? '',
          text: 'One more round',
          requestKey: 'over-budget',
        }),
      ).rejects.toThrow(/budget spent/);

      expect(await runRows(services.store, last?.id ?? '')).toEqual([]);
    } finally {
      await stop();
    }
  });

  it('refuses to reopen a conversation an agent already closed, or to call itself', async () => {
    const { services, caller, callee, peers } = await pair();
    const run = await ownerRun(services, caller, 'Open the conversation');

    const asked = peers.ask(run, {
      toProfileId: callee.id,
      text: 'Can you help?',
      requestKey: 'back',
    });

    const answered = await answerOnce(services, callee.id, 'Helped.');

    await asked;

    await expect(
      peers.ask(answered, { toProfileId: caller.id, text: 'And you?', requestKey: 'back-again' }),
    ).rejects.toThrow(/already spoke/);

    await expect(
      peers.ask(run, { toProfileId: caller.id, text: 'Myself', requestKey: 'self' }),
    ).rejects.toThrow(/cannot call itself/);

    expect(await runRows(services.store, caller.id)).toHaveLength(1);
  });

  it('reports a colleague that failed or does not exist instead of staying silent', async () => {
    const { services, caller, callee, peers } = await pair();
    const run = await ownerRun(services, caller, 'Ask for the impossible');

    const asked = peers.ask(run, {
      toProfileId: callee.id,
      text: 'Do the impossible',
      requestKey: 'failure',
    });

    await answerOnce(services, callee.id, 'Provider key is not configured', 'failed');

    await expect(asked).rejects.toThrow(/Operator could not answer/);

    await expect(
      peers.ask(run, {
        toProfileId: '00000000-0000-4000-8000-000000000001',
        text: 'Anyone there?',
        requestKey: 'absent',
      }),
    ).rejects.toThrow(/Profile not found/);
  });

  it('records the call on both sides so the owner can audit who spoke to whom', async () => {
    const { services, caller, callee, peers } = await pair();
    const run = await ownerRun(services, caller, 'Talk to the operator');

    const asked = peers.ask(run, {
      toProfileId: callee.id,
      text: 'Report, please',
      requestKey: 'audit',
    });

    const answered = await answerOnce(services, callee.id, 'Here is the report.');

    await asked;

    const sent = (await events(services.store, caller.id, 0)).filter(
      (event) => event.type === 'agent.call.sent',
    );

    const received = (await events(services.store, callee.id, 0)).filter(
      (event) => event.type === 'agent.call.received',
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]?.runId).toBe(run.id);
    expect(sent[0]?.data).toMatchObject({ toProfileId: callee.id, toName: 'Operator', depth: 1 });

    expect(received).toHaveLength(1);
    expect(received[0]?.runId).toBe(answered.id);

    expect(received[0]?.data).toMatchObject({
      fromProfileId: caller.id,
      fromName: 'Orchestrator',
      sessionId: answered.sessionId,
    });
  });
});

it('stops waiting on a slow colleague and carries the answer back when it lands', async () => {
  const { services, caller, callee } = await pair();
  const session = await services.sessions.createSession(caller.id, { title: 'Request' });

  const asking = await services.runs.submit(caller.id, session.id, {
    text: 'Ask the Operator',
    requestKey: 'ask',
  });

  // No wait at all: the point under test is what happens once the caller gives up.
  const impatient = new Peers(services, Date.now, { answerWithin: 0, pollEvery: 1 });

  const answer = await impatient.ask(await services.runs.run(caller.id, asking.id), {
    toProfileId: callee.id,
    text: 'How is the delivery going?',
    requestKey: 'slow',
  });

  expect(answer.status).toBe('waiting');

  const pending = (await services.runs.activities(callee.id))[0];
  if (!pending) throw new Error('The colleague never got the question');

  // The asking turn is over by the time a late answer lands; while it is still going the
  // answer joins it as a redirect instead, which is the same door the owner writes through.
  await services.lifecycle.claim(asking.id, caller.id, 'caller');
  await services.lifecycle.finish(caller.id, asking.id, 'caller', 'completed', 'Asked.');

  await services.lifecycle.claim(pending.id, callee.id, 'worker');
  await services.lifecycle.finish(
    callee.id,
    pending.id,
    'worker',
    'completed',
    'Delivered yesterday.',
  );
  await impatient.deliverLate(callee.id, pending.id);

  const carried = (await services.runs.activities(caller.id)).find((item) => item.id !== asking.id);

  expect(carried?.sessionId).toBe(session.id);
  expect(carried?.input).toContain('Delivered yesterday.');

  // Addressed once: a second pass must not start the conversation again.
  await impatient.deliverLate(callee.id, pending.id);
  expect(await services.runs.activities(caller.id)).toHaveLength(1);
});

it('carries saved progress when a colleague fails before its final report', async () => {
  const { services, caller, callee } = await pair();
  const asking = await ownerRun(services, caller, 'Review the changes');
  const peers = new Peers(services, Date.now, { answerWithin: 0, pollEvery: 1 });
  await peers.ask(asking, {
    toProfileId: callee.id,
    text: 'Q'.repeat(4000),
    requestKey: 'partial',
  });
  const pending = await queuedRun(services, callee.id);
  await services.lifecycle.claim(asking.id, caller.id, 'caller');
  await services.lifecycle.finish(caller.id, asking.id, 'caller', 'completed', 'Waiting.');
  await services.lifecycle.claim(pending.id, callee.id, 'worker');
  await services.lifecycle.say(
    callee.id,
    pending.id,
    'worker',
    `${'x'.repeat(3950)}\nFour changes were merged.`,
  );
  await services.lifecycle.finish(callee.id, pending.id, 'worker', 'failed', 'No final response.');

  await peers.deliverLate(callee.id, pending.id);

  const [carried] = await services.runs.activities(caller.id);
  expect(carried?.input).toContain('Four changes were merged.');
  expect(carried?.input).toContain('No final response.');
  expect(carried?.input).toContain('Do not assume nothing was done');
});
