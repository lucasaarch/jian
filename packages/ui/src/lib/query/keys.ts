/**
 * Every cache key the panel uses. Anything about one profile lives under `['profile', id]`, so
 * a refresh of that profile is one invalidation and never reaches another profile's data.
 * Installation-wide resources — the profiles themselves, providers, model defaults, groups —
 * sit at the root.
 */
export const keys = {
  profiles: ['profiles'] as const,
  providers: ['providers'] as const,
  providerModels: (providerId: string) => ['providers', providerId, 'models'] as const,
  modelDefaults: ['model-defaults'] as const,
  subscriptionUsage: ['subscription-usage'] as const,
  sshKeys: ['ssh-keys'] as const,
  groups: ['groups'] as const,
  githubIntegration: ['integrations', 'github'] as const,
  githubRepositories: ['integrations', 'github', 'repositories'] as const,
  githubLink: (url: string) => ['integrations', 'github', 'links', url] as const,
  githubItem: (kind: 'pull' | 'issue', owner: string, repo: string, number: number) =>
    ['integrations', 'github', kind, owner.toLowerCase(), repo.toLowerCase(), number] as const,
  remoteMachines: ['remote-machines'] as const,
  mcpServers: ['mcp-servers'] as const,
  releases: ['releases'] as const,
  repository: ['repository'] as const,
  gateway: ['gateway'] as const,
  settings: ['settings'] as const,

  profile: (profileId: string) => ['profile', profileId] as const,
  sessions: (profileId: string) => ['profile', profileId, 'sessions'] as const,
  projects: (profileId: string) => ['profile', profileId, 'projects'] as const,
  channels: (profileId: string) => ['profile', profileId, 'channels'] as const,
  contacts: (profileId: string) => ['profile', profileId, 'contacts'] as const,
  memories: (profileId: string) => ['profile', profileId, 'memories'] as const,
  activities: (profileId: string) => ['profile', profileId, 'activities'] as const,
  schedules: (profileId: string) => ['profile', profileId, 'schedules'] as const,
  scheduleHistory: (profileId: string, scheduleId: string) =>
    ['profile', profileId, 'schedules', scheduleId, 'history'] as const,
  media: (profileId: string, mediaId: string) => ['profile', profileId, 'media', mediaId] as const,
  channelConnection: (profileId: string, channelId: string) =>
    ['profile', profileId, 'channels', channelId, 'connection'] as const,
  channelQr: (profileId: string, channelId: string) =>
    ['profile', profileId, 'channels', channelId, 'qr'] as const,
  codexLogin: ['providers', 'openai', 'oauth'] as const,
  subscriptions: (profileId: string) => ['profile', profileId, 'subscriptions'] as const,
  builtinSkills: (profileId: string) => ['profile', profileId, 'builtin-skills'] as const,
  stats: (profileId: string, days: number) => ['profile', profileId, 'stats', days] as const,
  activityCalendar: (profileId: string, zone: string) =>
    ['profile', profileId, 'activity-calendar', zone] as const,
};
