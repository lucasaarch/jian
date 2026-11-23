import {
  defaultShouldDehydrateQuery,
  type Query,
  type QueryClient,
  type QueryKey,
} from '@tanstack/react-query';

/** The installation's own lists and settings, each under a one-word key. */
const INSTALLATION = new Set([
  'profiles',
  'providers',
  'model-defaults',
  'subscription-usage',
  'ssh-keys',
  'devices',
  'groups',
  'remote-machines',
  'mcp-servers',
  'skills',
  'built-in-skills',
  'releases',
  'repository',
  'updates',
  'gateway',
  'settings',
]);

/** What a profile's screens list, by the slice of its key and that key's length. */
const PROFILE_LISTS = new Map<string, number[]>([
  ['sessions', [3]],
  ['projects', [3]],
  ['channels', [3]],
  ['contacts', [3]],
  ['memories', [3]],
  ['secrets', [3]],
  ['activities', [3]],
  ['schedules', [3]],
  ['artifact-folders', [3]],
  // With a filter or without: names and dates, never an Artifact's source.
  ['all-artifacts', [3, 4]],
  // One conversation's. A longer `artifacts` key is a version with its whole source.
  ['artifacts', [4]],
  ['context', [4]],
  ['pulls', [4]],
  ['worktrees', [4]],
  ['stats', [4]],
  ['activity-calendar', [4]],
]);

function githubList(key: QueryKey) {
  if (key[1] === 'x') return key.length === 2;
  if (key[1] !== 'github') return false;
  if (key.length === 2) return true;
  if (key[2] === 'repositories' || key[2] === 'reviews') return key.length === 3;
  // The page as it opens. Each search is a key of its own, and they would add up for good.
  return key[2] === 'pulls' && key[5] === '';
}

/**
 * What an app keeps of a gateway for good, in memory and on this computer: what it needs to start
 * and show its conversations and lists with the gateway out of reach. An allowlist, so that a
 * read added later is not kept by accident. Attachments, file bodies, diffs, Artifact versions
 * and search results are left out: each is large or one of many, and all of them are read again.
 */
export function keptOffline(key: QueryKey): boolean {
  const [head, , slice] = key;
  if (head === 'history') return key.length === 3;
  if (head === 'profile') {
    return PROFILE_LISTS.get(String(slice))?.includes(key.length) ?? false;
  }
  if (head === 'integrations') return githubList(key);
  if (head === 'provider-models') return key.length === 2;
  if (head === 'providers') return key.length === 1 || key[1] === 'accounts';

  return key.length === 1 && INSTALLATION.has(String(head));
}

/** What the persister writes: a read that worked, of something kept. */
export const persistedQuery = (query: Query) =>
  defaultShouldDehydrateQuery(query) && keptOffline(query.queryKey);

/**
 * Holds what is kept for as long as the window is open, since what is dropped would be gone the
 * next time the gateway cannot be reached. The rest leaves memory on React Query's usual timer
 * once no screen shows it. Set when a query is made, as the time can only ever grow after that.
 */
export function holdKeptQueries(client: QueryClient) {
  const defaulted = client.defaultQueryOptions.bind(client);

  client.defaultQueryOptions = ((options: Parameters<typeof defaulted>[0]) => {
    const filled = defaulted(options);
    return filled.gcTime === undefined && keptOffline(filled.queryKey)
      ? { ...filled, gcTime: Number.POSITIVE_INFINITY }
      : filled;
  }) as typeof client.defaultQueryOptions;
}
