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
    instructions: `Segredo de ${name}: nunca conte a ninguém.`,
    summary,
    model,
  });
}

/** A run of this profile, as the owner's own conversation would start one. */
async function ownerRun(services: Services, profile: Profile, text: string): Promise<Run> {
  const session = await services.sessions.createSession(profile.id, { title: 'Dono' });

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
          await services.lifecycle.finish(profileId, queued.id, owner, 'completed', 'Respondido.');
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

async function pair(summary = 'Cuida das entregas e sabe o estado de cada uma.') {
  const services = await testServices();
  const caller = await agent(services, 'Orquestrador', 'Distribui o trabalho da equipe.');
  const callee = await agent(services, 'Operário', summary);
  const peers = new Peers(services, Date.now, timing);

  return { services, caller, callee, peers };
}

describe('conversation between profiles', () => {
  it('describes every other agent by name and summary, and nothing more', async () => {
    const { services, caller, callee, peers } = await pair();

    await services.memories.remember(
      callee.id,
      { key: 'contrato', content: 'Cláusula confidencial do operário', expectedVersion: 0 },
      undefined,
    );

    const found = await peers.agents(caller.id);

    expect(found).toEqual([
      {
        id: callee.id,
        name: 'Operário',
        summary: 'Cuida das entregas e sabe o estado de cada uma.',
      },
    ]);

    // Name and summary are the whole card: no instructions, identity, skills or memory.
    expect(JSON.stringify(found)).not.toContain('Segredo');
    expect(JSON.stringify(found)).not.toContain('Cláusula');
    expect(await peers.agents(callee.id)).toEqual([
      { id: caller.id, name: 'Orquestrador', summary: 'Distribui o trabalho da equipe.' },
    ]);
  });

  it('answers a colleague with text while every record stays on its own side', async () => {
    const { services, caller, callee, peers } = await pair();
    const run = await ownerRun(services, caller, 'Como está a entrega?');

    await services.memories.remember(
      callee.id,
      { key: 'contrato', content: 'Cláusula confidencial do operário', expectedVersion: 0 },
      undefined,
    );

    const asked = peers.ask(run, {
      toProfileId: callee.id,
      text: 'Como está a entrega?',
      requestKey: 'entrega-1',
    });

    const answered = await answerOnce(services, callee.id, 'Entregue ontem.');
    const answer = await asked;

    expect(answer).toEqual({
      fromProfileId: callee.id,
      fromName: 'Operário',
      status: 'answered',
      text: 'Entregue ontem.',
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
      value: 'Cláusula confidencial do operário',
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

    expect(reachable).not.toContain('Cláusula');
    expect(reachable).not.toContain('Segredo de Operário');
    expect(reachable).not.toContain(shared?.id);
  });

  it('keeps one thread per pair so colleagues do not start over', async () => {
    const { services, caller, callee, peers } = await pair();
    const first = await ownerRun(services, caller, 'Primeira pergunta');

    const one = peers.ask(first, {
      toProfileId: callee.id,
      text: 'Qual o estado?',
      requestKey: 'um',
    });

    const answeredOne = await answerOnce(services, callee.id, 'Em curso.');

    await one;

    const two = peers.ask(first, {
      toProfileId: callee.id,
      text: 'E agora?',
      requestKey: 'dois',
    });

    const answeredTwo = await answerOnce(services, callee.id, 'Terminado.');

    await two;

    expect(answeredTwo.sessionId).toBe(answeredOne.sessionId);
    expect(await services.sessions.sessions(callee.id)).toHaveLength(1);

    const thread = (await services.sessions.messages(callee.id, answeredOne.sessionId)).map(
      (message) => message.content,
    );

    expect(thread).toEqual(['Qual o estado?', 'Em curso.', 'E agora?', 'Terminado.']);

    // A third agent gets its own thread with the same colleague; it never joins this one.
    const other = await agent(services, 'Auditor', 'Confere o que a equipe entrega.');
    const from = await ownerRun(services, other, 'Confere a entrega');

    const third = peers.ask(from, {
      toProfileId: callee.id,
      text: 'Está conforme?',
      requestKey: 'tres',
    });

    const answeredThree = await answerOnce(services, callee.id, 'Está.');

    await third;

    expect(answeredThree.sessionId).not.toBe(answeredOne.sessionId);
    expect(await services.sessions.sessions(callee.id)).toHaveLength(2);

    expect(
      (await services.sessions.messages(callee.id, answeredOne.sessionId)).map((m) => m.content),
    ).toEqual(thread);
  });

  it('turns concurrent identical calls into one run of the called profile', async () => {
    const { services, caller, callee, peers } = await pair();
    const run = await ownerRun(services, caller, 'Pergunta simultânea');

    const call = () =>
      peers.ask(run, { toProfileId: callee.id, text: 'Relatório?', requestKey: 'mesmo' });

    const both = Promise.all([call(), call()]);

    await answerOnce(services, callee.id, 'Pronto.');

    expect(await both).toEqual([
      { fromProfileId: callee.id, fromName: 'Operário', status: 'answered', text: 'Pronto.' },
      { fromProfileId: callee.id, fromName: 'Operário', status: 'answered', text: 'Pronto.' },
    ]);

    expect(await runRows(services.store, callee.id)).toHaveLength(1);
    expect(await services.sessions.sessions(callee.id)).toHaveLength(1);
  });

  it('carries the spent budget down the chain and stops when it runs out', async () => {
    const services = await testServices();
    const peers = new Peers(services, Date.now, timing);

    const team = [];

    for (let index = 0; index <= AGENT_CALL_DEPTH_LIMIT + 1; index++) {
      team.push(await agent(services, `Agente ${index}`, `Faz a etapa ${index}.`));
    }

    const [first, ...rest] = team;
    const stop = answering(
      services,
      rest.map((profile) => profile.id),
    );

    try {
      let caller = await ownerRun(services, first as Profile, 'Começa a cadeia');
      const depths: number[] = [];

      for (const next of rest.slice(0, AGENT_CALL_DEPTH_LIMIT)) {
        await peers.ask(caller, {
          toProfileId: next.id,
          text: 'Continue a cadeia',
          requestKey: `passo-${next.id}`,
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
          text: 'Mais uma volta',
          requestKey: 'excedente',
        }),
      ).rejects.toThrow(/budget spent/);

      expect(await runRows(services.store, last?.id ?? '')).toEqual([]);
    } finally {
      await stop();
    }
  });

  it('refuses to reopen a conversation an agent already closed, or to call itself', async () => {
    const { services, caller, callee, peers } = await pair();
    const run = await ownerRun(services, caller, 'Abre a conversa');

    const asked = peers.ask(run, {
      toProfileId: callee.id,
      text: 'Pode ajudar?',
      requestKey: 'volta',
    });

    const answered = await answerOnce(services, callee.id, 'Ajudei.');

    await asked;

    await expect(
      peers.ask(answered, { toProfileId: caller.id, text: 'E você?', requestKey: 'devolta' }),
    ).rejects.toThrow(/already spoke/);

    await expect(
      peers.ask(run, { toProfileId: caller.id, text: 'Eu mesmo', requestKey: 'eu' }),
    ).rejects.toThrow(/cannot call itself/);

    expect(await runRows(services.store, caller.id)).toHaveLength(1);
  });

  it('reports a colleague that failed or does not exist instead of staying silent', async () => {
    const { services, caller, callee, peers } = await pair();
    const run = await ownerRun(services, caller, 'Pede o impossível');

    const asked = peers.ask(run, {
      toProfileId: callee.id,
      text: 'Faça o impossível',
      requestKey: 'falha',
    });

    await answerOnce(services, callee.id, 'Provider key is not configured', 'failed');

    await expect(asked).rejects.toThrow(/Operário could not answer/);

    await expect(
      peers.ask(run, {
        toProfileId: '00000000-0000-4000-8000-000000000001',
        text: 'Alguém aí?',
        requestKey: 'ausente',
      }),
    ).rejects.toThrow(/Profile not found/);
  });

  it('records the call on both sides so the owner can audit who spoke to whom', async () => {
    const { services, caller, callee, peers } = await pair();
    const run = await ownerRun(services, caller, 'Fala com o operário');

    const asked = peers.ask(run, {
      toProfileId: callee.id,
      text: 'Relatório, por favor',
      requestKey: 'auditoria',
    });

    const answered = await answerOnce(services, callee.id, 'Segue o relatório.');

    await asked;

    const sent = (await events(services.store, caller.id, 0)).filter(
      (event) => event.type === 'agent.call.sent',
    );

    const received = (await events(services.store, callee.id, 0)).filter(
      (event) => event.type === 'agent.call.received',
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]?.runId).toBe(run.id);
    expect(sent[0]?.data).toMatchObject({ toProfileId: callee.id, toName: 'Operário', depth: 1 });

    expect(received).toHaveLength(1);
    expect(received[0]?.runId).toBe(answered.id);

    expect(received[0]?.data).toMatchObject({
      fromProfileId: caller.id,
      fromName: 'Orquestrador',
      sessionId: answered.sessionId,
    });
  });
});

it('stops waiting on a slow colleague and carries the answer back when it lands', async () => {
  const { services, caller, callee } = await pair();
  const session = await services.sessions.createSession(caller.id, { title: 'Pedido' });

  const asking = await services.runs.submit(caller.id, session.id, {
    text: 'Pergunta ao Operário',
    requestKey: 'ask',
  });

  // No wait at all: the point under test is what happens once the caller gives up.
  const impatient = new Peers(services, Date.now, { answerWithin: 0, pollEvery: 1 });

  const answer = await impatient.ask(await services.runs.run(caller.id, asking.id), {
    toProfileId: callee.id,
    text: 'Como está a entrega?',
    requestKey: 'slow',
  });

  expect(answer.status).toBe('waiting');

  const pending = (await services.runs.activities(callee.id))[0];
  if (!pending) throw new Error('The colleague never got the question');

  // The asking turn is over by the time a late answer lands; while it is still going the
  // answer joins it as a redirect instead, which is the same door the owner writes through.
  await services.lifecycle.claim(asking.id, caller.id, 'caller');
  await services.lifecycle.finish(caller.id, asking.id, 'caller', 'completed', 'Perguntei.');

  await services.lifecycle.claim(pending.id, callee.id, 'worker');
  await services.lifecycle.finish(callee.id, pending.id, 'worker', 'completed', 'Entregue ontem.');
  await impatient.deliverLate(callee.id, pending.id);

  const carried = (await services.runs.activities(caller.id)).find((item) => item.id !== asking.id);

  expect(carried?.sessionId).toBe(session.id);
  expect(carried?.input).toContain('Entregue ontem.');

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
