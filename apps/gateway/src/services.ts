import { localPlace, remotePlace } from './agent/github-git-place.js';
import { prepareGitAccess } from './agent/worker-workspace.js';
import { Contexts } from './context/service.js';
import type { Clock } from './core/clock.js';
import { Decisions } from './decisions/service.js';
import { Devices } from './devices/service.js';
import { Errands } from './errands/service.js';
import type { GitHubIntegrations } from './integrations/github.js';
import { Learning } from './learning/service.js';
import { McpServers } from './mcp/service.js';
import { Media } from './media/service.js';
import { Memories } from './memories/service.js';
import { PushNotifications } from './notifications/push.js';
import { Peers } from './peers/service.js';
import { Profiles } from './profiles/service.js';
import { Projects } from './projects/service.js';
import type { ModelCatalog } from './providers/catalog-source.js';
import { Providers } from './providers/service.js';
import { SubscriptionUsageReader } from './providers/subscription-usage.js';
import { PullWatchers } from './pulls/service.js';
import { RepositoryStars } from './releases/repository.js';
import { ReleaseNotes } from './releases/service.js';
import { Remote } from './remote/service.js';
import { RunLifecycle } from './runs/lifecycle.js';
import { Runs } from './runs/service.js';
import { Schedules } from './schedules/service.js';
import type { GatewayVault } from './security/gateway-vault.js';
import { createSafeFetch } from './security/outbound.js';
import type { Vault } from './security/vault.js';
import { ObjectiveContinuation } from './sessions/continuation.js';
import { isPullCreation } from './sessions/created-pulls.js';
import { Sessions } from './sessions/service.js';
import { Settings } from './settings/service.js';
import { SshKeys } from './ssh/service.js';
import { Stats } from './stats/service.js';
import type { Store } from './storage/database.js';
import { Work } from './tasks/service.js';
import { machineBrowser } from './web/machine-browser.js';
import { WebSearch } from './web/service.js';
import { Workspaces } from './workspaces/service.js';
import { Worktrees } from './worktrees/service.js';

export type Services = {
  profiles: Profiles;
  providers: Providers;
  sessions: Sessions;
  projects: Projects;
  memories: Memories;
  media: Media;
  web: WebSearch;
  releases: ReleaseNotes;
  repository: RepositoryStars;
  decisions: Decisions;
  devices: Devices;
  runs: Runs;
  peers: Peers;
  learning: Learning;
  stats: Stats;
  subscriptionUsage: SubscriptionUsageReader;
  schedules: Schedules;
  settings: Settings;
  lifecycle: RunLifecycle;
  contexts: Contexts;
  errands: Errands;
  work: Work;
  objectives: ObjectiveContinuation;
  pulls: PullWatchers;
  workspaces: Workspaces;
  worktrees: Worktrees;
  vault: Vault;
  gatewayVault: GatewayVault;
  sshKeys: SshKeys;
  mcp: McpServers;
  remote: Remote;
  push: PushNotifications;
};

/**
 * How long a machine has for one git read the changes route asks, in ms: a few git commands of
 * at most 10 s each, and the panel is waiting on it.
 */
const MACHINE_CHANGES_TIMEOUT_MS = 30_000;

/** One wiring point: every area gets the same store, vault and clock. */
export function buildServices({
  store,
  vault,
  gatewayVault,
  clock = Date.now,
  catalog,
  fetcher,
  timeZone,
  github,
  publicUrl,
  nativeBrowser,
  mode,
}: {
  store: Store;
  vault: Vault;
  gatewayVault: GatewayVault;
  clock?: Clock;
  catalog?: ModelCatalog;
  fetcher?: typeof fetch;
  timeZone?: string;
  github?: Pick<GitHubIntegrations, 'repository' | 'repoRequest' | 'appLogin'>;
  nativeBrowser?: import('./web/native.js').NativeBrowser;
  /** A desktop app's own gateway is on the owner's computer, which a server is not. */
  mode?: 'server' | 'local';
  /** Where the panel is served, which push services are given as the sender. */
  publicUrl?: string;
}): Services {
  const profiles = new Profiles(store, clock);
  const providers = new Providers(store, gatewayVault, clock, catalog);
  const sessions = new Sessions(store, profiles, clock, mode === 'local');
  const projects = new Projects(store, profiles, clock, github);
  const memories = new Memories(store, profiles, sessions, clock);
  const runs = new Runs(store, profiles, sessions, providers, clock);
  const settings = new Settings(store, timeZone);
  const decisions = new Decisions(
    store,
    gatewayVault,
    fetcher ?? createSafeFetch().fetch,
    undefined,
    clock,
  );
  const media = new Media(store, providers, gatewayVault, fetcher ?? createSafeFetch().fetch);
  const subscriptionUsage = new SubscriptionUsageReader(
    providers,
    gatewayVault,
    fetcher ?? createSafeFetch().fetch,
    clock,
  );

  const push = new PushNotifications(
    store,
    gatewayVault,
    sessions,
    ...(publicUrl?.startsWith('https://') ? [publicUrl] : []),
  );
  const lifecycle = new RunLifecycle(store, runs, clock);
  // What the agent says in a chat of the panel reaches the owner's devices as it settles.
  lifecycle.useNotices(push);

  const remote = new Remote(store, clock, undefined, gatewayVault);
  // Without GitHub connected a created pull request is recorded as one nothing can watch.
  const pulls = new PullWatchers(
    store,
    runs,
    isPullCreation,
    clock,
    github
      ? { repoRequest: (...args) => github.repoRequest(...args), appLogin: () => github.appLogin() }
      : undefined,
    decisions.judge,
  );
  const sshKeys = new SshKeys(store, gatewayVault);
  const worktrees = new Worktrees(
    store,
    clock,
    async (profileId, place) =>
      place === 'gateway'
        ? localPlace(await prepareGitAccess(sshKeys))
        : remotePlace(profileId, place, remote),
    (message) => console.warn(message),
  );
  sessions.useWorktrees((profileId, sessionId) => worktrees.recorded(profileId, sessionId));
  sessions.useMachineFiles((profileId, machineId, op) =>
    remote.executeFiles(profileId, machineId, op, undefined, MACHINE_CHANGES_TIMEOUT_MS),
  );
  const services = {
    profiles,
    providers,
    sessions,
    projects,
    memories,
    media,
    // A desktop app's own gateway asks its app; a server asks an app that is one of its machines.
    web: new WebSearch(
      store,
      gatewayVault,
      fetcher ?? createSafeFetch().fetch,
      nativeBrowser ?? machineBrowser(remote),
    ),
    // Stamped into the image at build time; a gateway run from source has none.
    releases: new ReleaseNotes(
      store,
      process.env.JIAN_VERSION,
      undefined,
      fetcher ?? createSafeFetch().fetch,
    ),
    repository: new RepositoryStars(fetcher ?? createSafeFetch().fetch),
    decisions,
    devices: new Devices(store, clock),
    runs,
    peers: new Peers({ profiles, sessions, runs, store }, clock),
    learning: new Learning({ store, profiles, sessions, runs, judge: decisions.judge }, clock),
    // Without a catalog nothing has a list price, and every model counts as unknown.
    stats: new Stats(
      store,
      profiles,
      settings,
      catalog ?? { prime: async () => {}, lookup: () => undefined },
      clock,
      subscriptionUsage,
    ),
    subscriptionUsage,
    schedules: new Schedules(store, profiles, sessions, runs, clock),
    settings,
    lifecycle,
    contexts: new Contexts(store, runs, sessions, settings, decisions.judge, worktrees),
    errands: new Errands(store, clock),
    work: new Work(store, sessions, runs, clock, decisions.judge),
    objectives: new ObjectiveContinuation(store, sessions, runs, clock),
    pulls,
    workspaces: new Workspaces(
      store,
      (profileId, machineId, input, signal) => remote.execute(profileId, machineId, input, signal),
      clock,
      worktrees,
    ),
    worktrees,
    vault,
    gatewayVault,
    sshKeys,
    mcp: new McpServers(store, gatewayVault, clock),
    remote,
    push,
  };

  return services;
}
