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
  Session,
} from '../lib/api';

/**
 * One believable installation, synthetic from end to end: every story reads it, so a screen is
 * judged against the same agents, conversations and history wherever it appears.
 */

const at = (minutesAgo: number) =>
  new Date(Date.UTC(2026, 8, 24, 12) - minutesAgo * 60_000).toISOString();

export const ids = {
  zero: '5c52c291-4620-4829-aa8b-6adf08d8c833',
  miku: '8f41c4e7-cb7e-49ae-a0f0-e75956d4975e',
  ichigo: '39c2c2fd-6204-47d4-b3f3-e7ad41e4e25c',
  anthropic: '4219fb5c-a06b-4471-aa1b-d03505cf6ec9',
  openai: '6f3f5edf-4381-4f8a-9f6c-5ed51f97a0eb',
  telegram: 'db4710b8-8be4-48e3-8b89-bb7865f77ed5',
  whatsapp: '121600cb-13ac-4ed2-9284-3dff8d5e8779',
  ownerChat: '8b9e13a2-fe34-49fe-9409-4c16e4fe1055',
  groupChat: 'a07e6f2a-b9ff-483e-ab3a-f7d05b1af092',
  panelChat: '04a28114-545a-41b7-ba17-8673134b85d1',
  moabeContact: '0f7c5a41-2a4e-4d59-9a3b-6f0f6f1d2c11',
  ownerContact: '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d',
  roomContact: '2b3c4d5e-6f7a-4b2c-9d3e-4f5a6b7c8d9e',
  strangerContact: '3c4d5e6f-7a8b-4c3d-8e4f-5a6b7c8d9e0f',
  runDone: '66b4c0ba-1111-4a4a-8a8a-000000000001',
  runLive: '66b4c0ba-1111-4a4a-8a8a-000000000002',
  runFailed: '66b4c0ba-1111-4a4a-8a8a-000000000003',
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
    instructions: 'You are Zero Two, Lucas’s assistant. Be direct and warm.',
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
      },
    ],
    allowSelfManagement: true,
    allowWebSearch: true,
  },
  {
    ...profileBase,
    id: ids.miku,
    name: 'Miku',
    summary: 'Code review and pull requests across the VX repositories.',
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

export const sessions: Session[] = [
  {
    id: ids.ownerChat,
    profileId: ids.zero,
    title: 'Telegram · Lucas',
    channel: 'telegram',
    createdAt: at(60 * 24 * 2),
  },
  {
    id: ids.groupChat,
    profileId: ids.zero,
    title: 'Telegram · Equipe',
    channel: 'telegram',
    createdAt: at(60 * 24),
  },
  {
    id: ids.panelChat,
    profileId: ids.zero,
    title: 'Planning the week',
    channel: 'panel',
    summary: 'Lucas and Zero Two planned the release and the review of two epics.',
    createdAt: at(60 * 5),
  },
];

export const messages = [
  {
    id: 'a1000000-0000-4000-8000-000000000001',
    profileId: ids.zero,
    sessionId: ids.ownerChat,
    runId: ids.runDone,
    role: 'user' as const,
    content: 'Manda pro Moabe o link dos épicos e diz que tá pronto pra testar?',
    createdAt: at(42),
  },
  {
    id: 'a1000000-0000-4000-8000-000000000002',
    profileId: ids.zero,
    sessionId: ids.ownerChat,
    runId: ids.runDone,
    role: 'assistant' as const,
    content:
      'Mandei, Darling. O Moabe recebeu os dois links no WhatsApp:\n\n- #299 Compatibilidade\n- #300 Aliases',
    createdAt: at(41),
  },
  {
    id: 'a1000000-0000-4000-8000-000000000003',
    profileId: ids.zero,
    sessionId: ids.ownerChat,
    runId: ids.runLive,
    role: 'user' as const,
    content: 'Pesquisa o que é JEV pra mim',
    createdAt: at(2),
  },
];

const usage = {
  inputTokens: 18485,
  outputTokens: 332,
  cachedInputTokens: 9000,
  estimated: false,
  steps: 3,
};

export const runs: Run[] = [
  {
    id: ids.runLive,
    profileId: ids.zero,
    sessionId: ids.ownerChat,
    requestKey: 'live',
    input: 'Pesquisa o que é JEV pra mim',
    status: 'running',
    createdAt: at(2),
    updatedAt: at(1),
    progress: { phase: 'tool', tool: 'web_search', text: '', steps: 2, updatedAt: at(1) },
  },
  {
    id: ids.runDone,
    profileId: ids.zero,
    sessionId: ids.ownerChat,
    requestKey: 'done',
    input: 'Manda pro Moabe o link dos épicos',
    status: 'completed',
    output: 'Mandei, Darling.',
    usage,
    createdAt: at(42),
    updatedAt: at(41),
  },
  {
    id: ids.runFailed,
    profileId: ids.zero,
    sessionId: ids.panelChat,
    requestKey: 'failed',
    input: 'Resume a semana',
    status: 'failed',
    error: 'Provider key is not configured',
    createdAt: at(60 * 4),
    updatedAt: at(60 * 4),
  },
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

export const contacts: Contact[] = [
  {
    id: ids.ownerContact,
    profileId: ids.zero,
    channelId: ids.telegram,
    type: 'telegram',
    scope: 'direct',
    actorId: '8138773267',
    chatId: '8138773267',
    displayName: 'Lucas',
    status: 'approved',
    sessionId: ids.ownerChat,
    createdAt: at(60 * 24 * 9),
    updatedAt: at(60 * 24 * 9),
  },
  {
    id: ids.moabeContact,
    profileId: ids.zero,
    channelId: ids.whatsapp,
    type: 'whatsapp',
    scope: 'direct',
    actorId: '5571911111111@c.us',
    chatId: '5571911111111@c.us',
    displayName: 'Moabe',
    status: 'approved',
    createdAt: at(60 * 24 * 5),
    updatedAt: at(60 * 24 * 5),
  },
  {
    id: ids.roomContact,
    profileId: ids.zero,
    channelId: ids.telegram,
    type: 'telegram',
    scope: 'group',
    actorId: '-1002000000000',
    chatId: '-1002000000000',
    displayName: 'Equipe',
    status: 'approved',
    sessionId: ids.groupChat,
    createdAt: at(60 * 24),
    updatedAt: at(60 * 24),
  },
  {
    id: '5e6f7a8b-9c0d-4e5f-8a6b-7c8d9e0f1a2b',
    profileId: ids.zero,
    channelId: ids.telegram,
    type: 'telegram',
    scope: 'direct',
    actorId: '7001234567',
    chatId: '7001234567',
    displayName: 'Diêgo',
    status: 'blocked',
    createdAt: at(60 * 24 * 4),
    updatedAt: at(60 * 24 * 2),
  },
  {
    id: '6f7a8b9c-0d1e-4f6a-9b7c-8d9e0f1a2b3c',
    profileId: ids.zero,
    channelId: ids.telegram,
    type: 'telegram',
    scope: 'group',
    actorId: '-1003000000000',
    chatId: '-1003000000000',
    displayName: 'Clientes VX',
    status: 'pending',
    createdAt: at(12),
    updatedAt: at(12),
  },
  {
    id: ids.strangerContact,
    profileId: ids.zero,
    channelId: ids.whatsapp,
    type: 'whatsapp',
    scope: 'direct',
    actorId: '5571922222222@c.us',
    chatId: '5571922222222@c.us',
    status: 'pending',
    message: 'Oi, quem fala? Peguei esse número com o Diego.',
    createdAt: at(30),
    updatedAt: at(30),
  },
];

export const groups: Group[] = [
  {
    type: 'telegram',
    chatId: '-1002000000000',
    name: 'Equipe',
    profiles: [
      { profileId: ids.zero, name: 'Zero Two', contactId: ids.roomContact, status: 'approved' },
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
    id: ids.runDone,
    profileId: ids.zero,
    channelId: ids.telegram,
    runId: ids.runDone,
    chatId: '8138773267',
    status: 'sent',
    createdAt: at(42),
    updatedAt: at(41),
    remoteMessageIds: [101],
    saidCount: 0,
  },
];

export const memories: Memory[] = [
  {
    id: 'm1',
    profileId: ids.zero,
    key: 'owner.preferences.tone',
    content: 'Lucas prefers short answers on the phone and the details only when he asks.',
    version: 2,
    sourceSessionId: ids.ownerChat,
    updatedAt: at(60 * 24),
  },
  {
    id: 'm2',
    profileId: ids.zero,
    key: 'team.moabe',
    content: 'Moabe tests the epics before they reach production; reach him on WhatsApp.',
    version: 1,
    updatedAt: at(60 * 30),
  },
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

export const builtinSkills: BuiltinSkill[] = [
  {
    name: 'channel-replies',
    description:
      'Use before answering on WhatsApp, Telegram or in a group: plain text only, and short.',
    instructions: '# Writing for the channel you are in',
    enabled: true,
  },
  {
    name: 'machine-tools',
    description: 'Use before running commands: what the machine already has, how to install more.',
    instructions: '# The machine you run commands on',
    enabled: false,
  },
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
