import { PANEL_FEATURES } from '@jian/contracts';
import type { FastifyInstance } from 'fastify';
import { afterEach, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { gatewaySettings } from '../src/storage/schema.js';
import { REPORT_EVERY_MS, Telemetry } from '../src/telemetry/service.js';
import { testServices } from './helpers/services.js';

const token = 'test-token-that-is-at-least-32-characters';
const headers = { authorization: `Bearer ${token}` };
const NOW = Date.parse('2026-11-06T12:00:00Z');
const destination = { key: 'phc_synthetic_key', host: 'https://posthog.example.test' };

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

type Sent = { event: string; properties: Record<string, unknown> };

/** A gateway whose report goes to a fake PostHog, answering `status` while it is set. */
async function setup(env: NodeJS.ProcessEnv = {}) {
  const services = await testServices();
  const sent: Sent[][] = [];
  const posting = { status: 200, during: async () => {} };
  let now = NOW;
  const telemetry = new Telemetry(services.store, {
    env,
    fetcher: (async (_url: string, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)).batch);
      await posting.during();
      return new Response('{}', { status: posting.status });
    }) as typeof globalThis.fetch,
    version: '1.6.0',
    mode: 'server',
    role: 'all',
    clock: () => now,
    destination,
  });
  services.settings.useTelemetry(telemetry);
  const app = createApp({ ...services, token, logger: false });
  apps.push(app);
  const report = async () => {
    now += REPORT_EVERY_MS;
    return telemetry.reportIfDue();
  };
  const panel = (sent: Sent[] | undefined) => sent?.find((item) => item.event === 'panel_usage');
  return { app, services, telemetry, sent, posting, report, panel };
}

const usage = (counts: Record<string, number>, host = 'web', phone = false) => ({
  host,
  phone,
  counts,
});

const post = (app: FastifyInstance, payload: object, auth: Record<string, string> = headers) =>
  app.inject({ method: 'POST', url: '/v1/telemetry/panel-usage', headers: auth, payload });

it('refuses a caller without the owner credential, and any key or count outside the vocabulary', async () => {
  const { app, report, sent, panel } = await setup();

  expect((await post(app, usage({ chat: 1 }), {})).statusCode).toBe(401);
  // A name the owner typed has no key to travel under.
  expect((await post(app, usage({ chat: 1, 'Acme launch plan': 1 }))).statusCode).toBe(400);
  expect((await post(app, usage({ chat: 10_001 }))).statusCode).toBe(400);
  expect((await post(app, usage({ chat: -1 }))).statusCode).toBe(400);
  expect((await post(app, usage({ chat: 1.5 }))).statusCode).toBe(400);
  expect((await post(app, usage({ chat: 1 }, 'phone-app'))).statusCode).toBe(400);
  expect((await post(app, { ...usage({ chat: 1 }), note: 'Acme' })).statusCode).toBe(400);

  expect(await report()).toBe(true);
  expect(panel(sent[0])).toBeUndefined();
});

it('keeps nothing while the report is off, by the owner or by the host', async () => {
  const owner = await setup();
  await owner.telemetry.set(false);
  expect((await post(owner.app, usage({ chat: 3 }))).statusCode).toBe(204);
  await owner.telemetry.set(true);
  expect(await owner.report()).toBe(true);
  expect(owner.panel(owner.sent[0])).toBeUndefined();

  const host = await setup({ DO_NOT_TRACK: '1' });
  expect((await post(host.app, usage({ chat: 3 }))).statusCode).toBe(204);
  const kept = await host.services.store.db.select().from(gatewaySettings);
  expect(kept.map((row) => row.key)).not.toContain('telemetryPanelUsage');
});

it('adds up every report of every panel, at once or one after another, by host', async () => {
  const { app, report, sent, panel } = await setup();

  await post(app, usage({ chat: 2, artifacts_page: 1 }));
  const answers = await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      post(app, usage({ chat: 1 }, index % 2 ? 'desktop' : 'web', index % 3 === 0)),
    ),
  );
  expect(answers.map((answer) => answer.statusCode)).toEqual(Array(12).fill(204));

  expect(await report()).toBe(true);
  const event = panel(sent[0]);
  expect(event?.properties).toMatchObject({
    version: '1.6.0',
    $process_person_profile: false,
    features: { chat: 14, artifacts_page: 1 },
    hosts: {
      web: { chat: 2 + 4, artifacts_page: 1 },
      web_phone: { chat: 2 },
      desktop: { chat: 4 },
      desktop_phone: { chat: 2 },
    },
  });
  const active = sent[0]?.find((item) => item.event === 'gateway_active') as {
    distinct_id?: string;
  };
  expect(event).toHaveProperty('distinct_id', active.distinct_id);
});

it('takes the counts off only once a report carrying them is delivered', async () => {
  const { app, report, sent, panel, posting } = await setup();
  await post(app, usage({ message_sent: 5 }));

  posting.status = 503;
  expect(await report()).toBe(false);
  posting.status = 200;
  // A panel reports while the report is on its way: that count waits for the next one.
  posting.during = async () => {
    posting.during = async () => {};
    await post(app, usage({ message_sent: 1, new_chat: 1 }));
  };
  expect(await report()).toBe(true);
  expect(await report()).toBe(true);
  expect(await report()).toBe(true);

  expect(sent.map((batch) => panel(batch)?.properties.features)).toEqual([
    { message_sent: 5 },
    { message_sent: 5 },
    { message_sent: 1, new_chat: 1 },
    undefined,
  ]);
});

it('sends nothing but the vocabulary, whatever was kept', async () => {
  const { app, report, sent, panel, services } = await setup();
  // A value a later release left behind, or one written by hand.
  await services.store.db.insert(gatewaySettings).values({
    key: 'telemetryPanelUsage',
    value: {
      web: { chat: 1, 'Acme roadmap': 4, plugins: 'many' },
      'Acme laptop': { chat: 9 },
    },
  });
  await post(app, usage({ artifact_prompt_copied_react_native: 1 }, 'desktop'));

  expect(await report()).toBe(true);
  const event = panel(sent[0]);
  expect(event?.properties.features).toEqual({ chat: 1, artifact_prompt_copied_react_native: 1 });
  expect(Object.keys(event?.properties.hosts ?? {})).toEqual(['web', 'desktop']);
  const features = Object.keys(event?.properties.features ?? {});
  expect(features.every((key) => (PANEL_FEATURES as string[]).includes(key))).toBe(true);
  expect(JSON.stringify(sent).toLowerCase()).not.toContain('acme');
});
