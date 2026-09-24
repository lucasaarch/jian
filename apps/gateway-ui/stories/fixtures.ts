import type {
  ActivityDay,
  BuiltinSkill,
  Channel,
  Connection,
  Contact,
  Delivery,
  Group,
  Memory,
  ModelDefaults,
  Profile,
  Provider,
  ProviderModelList,
  Run,
  Schedule,
  Session,
} from '../lib/api';

/**
 * One believable installation, synthetic from end to end: every story reads it, so a screen is
 * judged against the same agents, conversations and history wherever it appears.
 */

import {
  at,
  ids as chats,
  lastMessageOf,
  messages as scripted,
  people as scriptedPeople,
  runs as scriptedRuns,
  timelines as scriptedTimelines,
} from './conversations';
import { portrait, media as scriptedMedia } from './media';

export const ids = {
  ...chats,
  ichigo: '39c2c2fd-6204-47d4-b3f3-e7ad41e4e25c',
  anthropic: '4219fb5c-a06b-4471-aa1b-d03505cf6ec9',
  openai: '6f3f5edf-4381-4f8a-9f6c-5ed51f97a0eb',
  telegram: 'db4710b8-8be4-48e3-8b89-bb7865f77ed5',
  whatsapp: '121600cb-13ac-4ed2-9284-3dff8d5e8779',
  mayaContact: '0f7c5a41-2a4e-4d59-9a3b-6f0f6f1d2c11',
  theoContact: '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d',
  designContact: '2b3c4d5e-6f7a-4b2c-9d3e-4f5a6b7c8d9e',
  launchContact: '7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d',
  strangerContact: '3c4d5e6f-7a8b-4c3d-8e4f-5a6b7c8d9e0f',
};

const profileBase = {
  avatar: null,
  model: { provider: 'openai' as const, modelId: 'unconfigured' },
  contextPolicy: {
    inputTokens: 32000,
    outputTokens: 4096,
    memoryTokens: 1500,
    historyTokens: 6000,
    toolResultTokens: 1500,
    maxSteps: 200,
    maxRunTokens: 500000,
  },
  disabledSkills: [],
  allowSelfManagement: false,
  allowShell: false,
  allowWebSearch: false,
  learnFromWork: true,
  version: 3,
  createdAt: at(60 * 24 * 30),
  updatedAt: at(60 * 3),
};

export const profiles: Profile[] = [
  {
    ...profileBase,
    id: ids.zero,
    name: 'Zero Two',
    summary: 'The owner’s main assistant: schedules, messages and the day’s loose ends.',
    instructions: 'You are Zero Two, the owner’s assistant. Be direct and warm.',
    identity: {
      role: 'Personal assistant',
      tone: 'Direct, warm, a little teasing',
      goals: ['Keep the day moving', 'Close loops without being asked twice'],
      boundaries: ['Never send money', 'Ask before writing to someone new'],
    },
    skills: [
      {
        name: 'concise',
        description: 'Answer in the first sentence; every word earns its place.',
        instructions: 'Lead with the answer.',
        origin: { url: 'https://github.com/example/skills', importedAt: at(60 * 24 * 7) },
      },
    ],
    mcpServers: [
      {
        name: 'github',
        transport: 'http',
        url: 'https://api.githubcopilot.com/mcp/',
        auth: 'headers',
        headers: [{ name: 'Authorization' }],
        args: [],
        env: [],
        disabledTools: ['create_issue'],
      },
    ],
    allowSelfManagement: true,
    allowWebSearch: true,
    learnFromWork: true,
  },
  {
    ...profileBase,
    id: ids.miku,
    name: 'Miku',
    summary: 'Code review and pull requests across the Northwind repositories.',
    instructions: 'You are Miku. Review code with precision.',
    identity: { role: 'Code reviewer', tone: 'Precise', goals: [], boundaries: [] },
    skills: [],
    mcpServers: [],
    allowShell: true,
  },
  {
    ...profileBase,
    id: ids.ichigo,
    name: 'Ichigo',
    summary: '',
    instructions: 'You are Ichigo.',
    identity: { role: '', tone: '', goals: [], boundaries: [] },
    skills: [],
    mcpServers: [],
  },
];

const session = (
  id: string,
  channel: string,
  title: string | null,
  createdAgo: number,
  extra: Partial<Session> = {},
): Session => {
  const lastMessage = lastMessageOf(id);

  return {
    id,
    profileId: ids.zero,
    title,
    channel,
    ...(lastMessage ? { lastMessage } : {}),
    createdAt: at(createdAgo),
    ...extra,
  };
};

/** One conversation per situation the Sessions screen handles; see `conversations.ts`. */
export const sessions: Session[] = [
  session(ids.gatewayChat, 'gateway', 'Gateway', 60 * 24 * 30),
  session(ids.mayaChat, 'whatsapp', 'WhatsApp · Maya Chen', 60 * 24 * 12),
  session(ids.launchGroup, 'whatsapp', 'WhatsApp · Northwind Launch', 60 * 24 * 6),
  session(ids.theoChat, 'telegram', 'Telegram · Theo Park', 60 * 24 * 9),
  session(ids.designGroup, 'telegram', 'Telegram · Design Team', 60 * 24 * 4),
  session(ids.peerChat, 'agent', 'Agent · Miku', 60 * 24 * 2, { peerProfileId: ids.miku }),
  session(ids.learning, 'learning', 'Learning', 60 * 24 * 3),
  session(ids.reportChat, 'api', 'Nightly report', 60 * 24 * 20),
  session(ids.planningChat, 'api', 'Planning the week', 60 * 5, {
    summary: 'The owner asked for the week in review; the provider key was missing.',
  }),
  session(ids.emptyChat, 'api', null, 60 * 20),
];

export const messages = scripted;
export const media = scriptedMedia;
export const timelines = scriptedTimelines;
export const people = scriptedPeople;
export const runs: Run[] = scriptedRuns;

const schedule = (
  id: number,
  fields: Pick<Schedule, 'name' | 'instruction' | 'sessionId'> & Partial<Schedule>,
): Schedule => ({
  id: `5c4ed01e-0000-4000-8000-${String(id).padStart(12, '0')}`,
  profileId: ids.zero,
  timeZone: 'America/Sao_Paulo',
  enabled: true,
  createdBy: 'owner',
  createdAt: at(60 * 24 * 7),
  updatedAt: at(60 * 4),
  ...fields,
});

/** Routines the owner set and ones the agent set when asked, including a paused and a failed one. */
export const schedules: Schedule[] = [
  schedule(1, {
    name: 'Morning summary',
    instruction: 'Send me a summary of yesterday and what is due today.',
    sessionId: ids.gatewayChat,
    cron: '0 8 * * *',
    nextRunAt: '2026-09-25T11:00:00.000Z',
    lastRunAt: at(60 * 4),
  }),
  schedule(2, {
    name: 'Weekly update to Maya',
    instruction:
      'Write Maya a short update on the Northwind launch: what moved this week and what is at risk.',
    sessionId: ids.mayaChat,
    cron: '0 17 * * 5',
    nextRunAt: '2026-09-25T20:00:00.000Z',
    createdBy: 'agent',
  }),
  schedule(3, {
    name: 'Call the dentist',
    instruction: 'Remind me to call the dentist to move the appointment.',
    sessionId: ids.gatewayChat,
    at: '2026-09-24T18:00:00.000Z',
    nextRunAt: '2026-09-24T18:00:00.000Z',
    createdBy: 'agent',
  }),
  schedule(6, {
    name: 'Send Maya the contract',
    instruction: 'Remind me to send Maya the signed venue contract.',
    sessionId: ids.gatewayChat,
    at: '2026-09-22T13:00:00.000Z',
    enabled: false,
    lastRunAt: '2026-09-22T13:00:04.000Z',
  }),
  schedule(4, {
    name: 'Stand-up nudge',
    instruction: 'Remind the team that stand-up starts in 5 minutes.',
    sessionId: ids.designGroup,
    cron: '55 9 * * 1-5',
    enabled: false,
  }),
  schedule(5, {
    name: 'Nightly backup check',
    instruction: 'Check that last night’s backup finished and tell me only if it did not.',
    sessionId: ids.reportChat,
    cron: '0 6 * * *',
    nextRunAt: '2026-09-25T09:00:00.000Z',
    lastRunAt: at(60 * 6),
    lastError: 'The provider key is not configured. Add one under Providers.',
  }),
];

export const channels: Channel[] = [
  { id: ids.telegram, profileId: ids.zero, type: 'telegram', createdAt: at(60 * 24 * 10) },
  { id: ids.whatsapp, profileId: ids.zero, type: 'whatsapp', createdAt: at(60 * 24 * 10) },
];

export const connection: Connection = {
  channelId: ids.whatsapp,
  status: 'connected',
  accountId: '5571900000000@c.us',
  sessionSavedAt: at(10),
  updatedAt: at(10),
};

const contact = (
  id: string,
  channel: 'telegram' | 'whatsapp',
  scope: 'direct' | 'group',
  actorId: string,
  status: Contact['status'],
  ago: number,
  extra: Partial<Contact> = {},
): Contact => ({
  id,
  profileId: ids.zero,
  channelId: channel === 'telegram' ? ids.telegram : ids.whatsapp,
  type: channel,
  scope,
  actorId,
  chatId: actorId,
  status,
  createdAt: at(ago),
  updatedAt: at(ago),
  ...extra,
});

export const contacts: Contact[] = [
  contact(ids.mayaContact, 'whatsapp', 'direct', '4915550100001@c.us', 'approved', 60 * 24 * 12, {
    displayName: 'Maya Chen',
    sessionId: ids.mayaChat,
    avatar: portrait('#e6f4ea', '#2f7a52'),
  }),
  contact(
    ids.launchContact,
    'whatsapp',
    'group',
    '120363000000000001@g.us',
    'approved',
    60 * 24 * 6,
    {
      displayName: 'Northwind Launch',
      sessionId: ids.launchGroup,
      avatar: portrait('#ffe9d6', '#c2571a'),
    },
  ),
  contact(ids.theoContact, 'telegram', 'direct', '7004410021', 'approved', 60 * 24 * 9, {
    displayName: 'Theo Park',
    sessionId: ids.theoChat,
    avatar: portrait('#dbe7ff', '#3b5b9a'),
  }),
  contact(ids.designContact, 'telegram', 'group', '-1002000000000', 'approved', 60 * 24 * 4, {
    displayName: 'Design Team',
    sessionId: ids.designGroup,
    avatar: portrait('#fde2e8', '#b51e49'),
  }),
  contact(
    '5e6f7a8b-9c0d-4e5f-8a6b-7c8d9e0f1a2b',
    'telegram',
    'direct',
    '7001234567',
    'blocked',
    60 * 24 * 4,
    {
      displayName: 'Rowan Hale',
    },
  ),
  contact(
    '6f7a8b9c-0d1e-4f6a-9b7c-8d9e0f1a2b3c',
    'telegram',
    'group',
    '-1003000000000',
    'pending',
    12,
    {
      displayName: 'Northwind Clients',
    },
  ),
  contact(ids.strangerContact, 'whatsapp', 'direct', '4915550100009@c.us', 'pending', 30, {
    message: 'Hi, who is this? Omar gave me this number.',
    avatar: portrait('#fff4d6', '#9a6b1d'),
  }),
];

export const groups: Group[] = [
  {
    type: 'telegram',
    chatId: '-1002000000000',
    name: 'Design Team',
    profiles: [
      { profileId: ids.zero, name: 'Zero Two', contactId: ids.designContact, status: 'approved' },
      {
        profileId: ids.miku,
        name: 'Miku',
        contactId: '4d5e6f7a-8b9c-4d4e-9f5a-6b7c8d9e0f1a',
        status: 'pending',
      },
    ],
  },
];

export const deliveries: Delivery[] = [
  {
    id: ids.runLive,
    profileId: ids.zero,
    channelId: ids.telegram,
    runId: ids.runLive,
    chatId: '7004410021',
    status: 'sent',
    createdAt: at(42),
    updatedAt: at(41),
    remoteMessageIds: [101],
    saidCount: 0,
  },
];

const memory = (
  key: string,
  content: string,
  version: number,
  ago: number,
  links: string[],
  fromConversation = true,
): Memory => ({
  id: `m-${key}`,
  profileId: ids.zero,
  key,
  content,
  version,
  links,
  ...(fromConversation ? { sourceSessionId: ids.gatewayChat } : {}),
  updatedAt: at(ago),
});

/** A profile's notebook with two topics linked inside, and one entry on its own. */
export const memories: Memory[] = [
  memory(
    'owner-preferences',
    'The owner prefers short answers on the phone and the details only when asked. Since March 2026 they want summaries as bullet points.',
    3,
    60 * 24,
    ['owner-schedule'],
  ),
  memory(
    'owner-schedule',
    'Deep work until 11:00; no calls before then. Fridays are for reviews.',
    1,
    60 * 30,
    ['owner-preferences'],
  ),
  memory(
    'project-northwind-launch',
    'Northwind launch: beta opens October 2, public launch October 16. The payment provider review is the open risk.',
    4,
    60 * 5,
    ['team-maya-chen', 'venue-contract'],
  ),
  memory(
    'team-maya-chen',
    'Maya Chen runs the Northwind launch; reach her on WhatsApp. She prefers updates on Fridays.',
    2,
    60 * 26,
    ['project-northwind-launch'],
  ),
  memory(
    'venue-contract',
    'Venue deposit is 30% on signature; cancelling needs 21 days of notice.',
    2,
    60 * 25,
    ['project-northwind-launch'],
    false,
  ),
  memory(
    'webhook-timeouts',
    'Payment webhooks time out on the provider side. We retry 3 times with a 10s timeout and alert past 5 failures an hour.',
    1,
    60 * 2,
    [],
  ),
];

export const providers: Provider[] = [
  {
    id: ids.anthropic,
    name: 'Anthropic',
    kind: 'anthropic',
    credential: 'key',
    authMode: 'api',
    createdAt: at(60 * 24 * 20),
  },
  {
    id: ids.openai,
    name: 'OpenAI',
    kind: 'openai',
    authMode: 'codex',
    createdAt: at(60 * 24 * 3),
  },
];

const model = (id: string, extra: Partial<ProviderModelList['models'][number]> = {}) => ({
  id,
  contextWindow: 400000,
  maxOutputTokens: 64000,
  reasoningEfforts: ['low' as const, 'medium' as const, 'high' as const],
  inputModalities: ['text' as const, 'image' as const],
  known: true,
  ...extra,
});

export const providerModels: Record<string, ProviderModelList> = {
  [ids.anthropic]: {
    providerId: ids.anthropic,
    models: [
      model('claude-sonnet-5', { displayName: 'Claude Sonnet 5' }),
      model('claude-opus-5-5'),
    ],
    fetchedAt: at(60),
    stale: false,
  },
  [ids.openai]: {
    providerId: ids.openai,
    models: [model('gpt-5.6-sol'), model('gpt-5.6-luna', { known: false })],
    fetchedAt: at(60),
    stale: false,
  },
};

export const modelDefaults: ModelDefaults = {
  id: ids.zero,
  profileId: ids.zero,
  updatedAt: at(60 * 24),
  conversation: {
    providerId: ids.anthropic,
    modelId: 'claude-sonnet-5',
    reasoningEffort: 'medium',
  },
  channel: { providerId: ids.anthropic, modelId: 'claude-sonnet-5', reasoningEffort: 'medium' },
  compaction: { providerId: ids.openai, modelId: 'gpt-5.6-luna', reasoningEffort: 'low' },
  image: null,
  vision: null,
  audio: null,
  speech: null,
  transcription: null,
};

const builtin = (name: string, description: string, enabled = true): BuiltinSkill => ({
  name,
  description,
  instructions: `# ${name}\n\nThe full text ships with the gateway.`,
  enabled,
});

export const builtinSkills: BuiltinSkill[] = [
  {
    name: 'channel-replies',
    description:
      'Use before answering on WhatsApp, Telegram or in a group: plain text only, and short.',
    instructions:
      '# Writing for the channel you are in\n\nA chat app is not a document. Write the way a person texts:\n\n- One idea per message, short\n- **No Markdown**: WhatsApp and Telegram show the asterisks\n- Links on their own line\n\n## In a group\n\n1. Answer only when called by name or mention\n2. Say who you are answering when several people asked\n\n> When in doubt, shorter.\n\n```\nGood: Done, the invoice is in your email.\nBad: **Summary:** I have completed the following steps…\n```',
    enabled: true,
  },
  builtin(
    'about-jian',
    'Use when asked what you are, what Jian is, who made it, where to get it, or why something of yours is not working.',
  ),
  builtin(
    'schedules',
    'Use when asked to remind someone, do something later or at a time, or repeat something.',
  ),
  builtin(
    'media',
    'Use when someone sends an image, voice note, PDF or file, or asks for an image or a voice reply.',
  ),
  builtin(
    'coding-work',
    'Use when asked to read, fix, change or review code, run tests, or work with Git or GitHub.',
  ),
  {
    name: 'machine-tools',
    description:
      'Use before running commands or installing anything: what the machine has and how to install more.',
    instructions:
      '# The machine you run commands on\n\nCommands run in a container with Node, Python and git. Install more for this user only:\n\n```\nnpm install -g <package>\nuv tool install <package>\n```\n\nThere is no `sudo`, and nothing outside `/home/node` survives a restart.',
    enabled: true,
  },
  builtin(
    'discernment-nudge',
    'Use after advice, a draft or an analysis the owner may act on: append two or three specific checks.',
    false,
  ),
];

/** A year of work with a rhythm to it: busy weekdays, quiet weekends, a gap in the middle. */
export const activityCalendar: ActivityDay[] = Array.from({ length: 365 }, (_, index) => {
  const day = new Date(Date.UTC(2026, 8, 24) - index * 86_400_000);
  const weekend = day.getUTCDay() === 0 || day.getUTCDay() === 6;
  const runs = index > 150 && index < 170 ? 0 : weekend ? index % 3 : (index * 7) % 13;

  return { day: day.toISOString().slice(0, 10), runs, tokens: runs * 14_000 };
});

export const releases = {
  version: '2.2.0',
  notes: [] as unknown[],
  unseen: [
    {
      version: '2.2.0',
      date: '2026-09-24',
      summary: 'Agents search the web, and the panel says what changed after an update.',
      body: '## Web search\n\nAdd a Tavily key under **Providers** and switch on **Allow web search** on a profile.\n\n- `web_search` finds pages\n- `fetch_url` reads one as text\n\n## Releases\n\nThis dialog opens once after each update.',
      prerelease: false,
    },
  ],
};
