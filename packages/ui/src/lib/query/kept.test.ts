import { dehydrate, hydrate, QueryObserver } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createQueryClient } from './client';
import { persistedQuery } from './kept';
import { keys } from './keys';

const AGENT = 'mia';
const CHAT = 'atlas';

/** What a desktop app needs to open with its gateway away: every list that holds a screen up. */
const OFFLINE_START = [
  keys.profiles,
  keys.providers,
  keys.providerAccounts,
  keys.providerModels('anthropic'),
  keys.modelDefaults,
  keys.groups,
  keys.mcpServers,
  keys.gateway,
  keys.settings,
  keys.releases,
  keys.sessions(AGENT),
  keys.projects(AGENT),
  keys.channels(AGENT),
  keys.contacts(AGENT),
  keys.memories(AGENT),
  keys.activities(AGENT),
  keys.schedules(AGENT),
  keys.sessionContext(AGENT, CHAT),
  keys.sessionPulls(AGENT, CHAT),
  keys.sessionWorktrees(AGENT, CHAT),
  keys.sessionArtifacts(AGENT, CHAT),
  keys.profileArtifacts(AGENT, { project: 'all' }),
  ['history', AGENT, CHAT],
];

const HEAVY = [
  keys.media(AGENT, 'picture'),
  keys.sessionFiles(AGENT, CHAT),
  keys.sessionFiles(AGENT, CHAT, 'project', 'src/index.ts'),
  keys.sessionChanges(AGENT, CHAT, 'src/index.ts'),
  keys.sessionTimeline(AGENT, CHAT),
  keys.sessionArtifacts(AGENT, CHAT, 'artifact', 3),
  keys.githubItem('pull', 'acme', 'atlas', 7),
  keys.githubLink('https://github.com/acme/atlas/pull/7'),
  keys.githubPulls('open', 'acme/atlas', 'a search'),
  keys.scheduleHistory(AGENT, 'morning'),
  keys.channelQr(AGENT, 'whatsapp'),
];

const written = (client: ReturnType<typeof createQueryClient>) =>
  dehydrate(client, { shouldDehydrateQuery: persistedQuery }).queries.map(({ queryKey }) =>
    JSON.stringify(queryKey),
  );

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

it('writes down what an offline start needs, and none of what is large or one of many', () => {
  const client = createQueryClient({ kept: true });
  for (const key of [...OFFLINE_START, ...HEAVY]) client.setQueryData(key, { from: 'gateway' });

  expect(written(client).sort()).toEqual(OFFLINE_START.map((key) => JSON.stringify(key)).sort());
});

it('opens a conversation and its list from what was written, with the gateway away', async () => {
  const before = createQueryClient({ kept: true });
  before.setQueryData(['history', AGENT, CHAT], { messages: ['Good morning'] });
  before.setQueryData(keys.sessions(AGENT), [{ id: CHAT }]);
  const saved = JSON.parse(
    JSON.stringify(dehydrate(before, { shouldDehydrateQuery: persistedQuery })),
  );

  const after = createQueryClient({ kept: true });
  hydrate(after, saved);
  await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);

  expect(after.getQueryData(['history', AGENT, CHAT])).toEqual({ messages: ['Good morning'] });
  expect(after.getQueryData(keys.sessions(AGENT))).toEqual([{ id: CHAT }]);
});

it('keeps lists in memory for good and lets go of an attachment no screen shows', async () => {
  const client = createQueryClient({ kept: true });
  const media = keys.media(AGENT, 'picture');
  client.setQueryData(keys.sessions(AGENT), [{ id: CHAT }]);
  const stop = new QueryObserver(client, {
    queryKey: media,
    queryFn: async () => ({ data: 'a large picture' }),
  }).subscribe(() => {});
  await vi.advanceTimersByTimeAsync(0);
  stop();

  await vi.advanceTimersByTimeAsync(6 * 60_000);

  expect(client.getQueryData(media)).toBeUndefined();
  expect(client.getQueryData(keys.sessions(AGENT))).toEqual([{ id: CHAT }]);
});

it('leaves the web panel on the usual timer, with nothing held for good', async () => {
  const client = createQueryClient();
  client.setQueryData(keys.sessions(AGENT), [{ id: CHAT }]);

  await vi.advanceTimersByTimeAsync(6 * 60_000);

  expect(client.getQueryData(keys.sessions(AGENT))).toBeUndefined();
});
