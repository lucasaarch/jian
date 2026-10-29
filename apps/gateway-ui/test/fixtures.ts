import type { Profile } from '../lib/api';

/**
 * The synthetic agent and usage the unit tests render with. Fictional from end to end; nothing
 * here points at a real person, account or gateway.
 */

/** A fixed instant, so a test reads the same dates whenever it runs. */
const at = (minutesAgo: number) =>
  new Date(Date.UTC(2026, 8, 24, 12) - minutesAgo * 60_000).toISOString();

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
  allowShell: false,
  version: 3,
  createdAt: at(60 * 24 * 30),
  updatedAt: at(60 * 3),
};

export const profile: Profile = {
  ...profileBase,
  id: '5c52c291-4620-4829-aa8b-6adf08d8c833',
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
};

export const statsFor = (days: number) => {
  const shown = Math.min(days, 90);
  const scale = Math.min(days, 90) / 30;
  const daily = Array.from({ length: shown }, (_, index) => {
    const date = new Date();

    date.setDate(date.getDate() - (shown - 1 - index));

    return {
      day: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`,
      tokens: index % 7 === 5 ? 0 : Math.round(180_000 + ((index * 7919) % 11) * 95_000),
    };
  }).filter((item) => item.tokens > 0);

  return {
    since: at(60 * 24 * 41),
    subscriptions: [
      {
        provider: 'codex' as const,
        status: 'available' as const,
        fiveHour: null,
        weekly: { usedPercent: 32, resetsAt: null },
      },
      {
        provider: 'claude' as const,
        status: 'unavailable' as const,
        fiveHour: null,
        weekly: null,
      },
    ],
    totals: {
      turns: 1583,
      workedMs: 139_800_000,
      conversations: 10,
      skillsWritten: 3,
      memories: 6,
    },
    period: {
      days,
      from: at(60 * 24 * days),
      turns: Math.round(412 * scale),
      tokens: {
        input: Math.round(9_400_000 * scale),
        cached: Math.round(21_700_000 * scale),
        output: Math.round(1_180_000 * scale),
      },
      cost: Math.round(48.37 * scale * 100) / 100,
      unpricedTokens: Math.round(6_200_000 * scale),
      activeDays: daily.length,
      daily,
    },
    models: [
      {
        provider: 'anthropic',
        modelId: 'claude-opus-4-6',
        billing: 'metered',
        turns: Math.round(318 * scale),
        tokens: {
          input: Math.round(7_900_000 * scale),
          cached: Math.round(18_300_000 * scale),
          output: Math.round(930_000 * scale),
        },
        cost: Math.round(48.37 * scale * 100) / 100,
      },
      {
        provider: 'openai-codex',
        modelId: 'gpt-5-codex',
        billing: 'subscription',
        turns: Math.round(94 * scale),
        tokens: {
          input: Math.round(1_500_000 * scale),
          cached: Math.round(3_400_000 * scale),
          output: Math.round(250_000 * scale),
        },
        cost: null,
      },
    ],
    channels: [
      {
        channel: 'whatsapp',
        conversations: 4,
        turns: Math.round(201 * scale),
        tokens: Math.round(15_800_000 * scale),
      },
      {
        channel: 'gateway',
        conversations: 1,
        turns: Math.round(96 * scale),
        tokens: Math.round(9_900_000 * scale),
      },
      {
        channel: 'telegram',
        conversations: 2,
        turns: Math.round(71 * scale),
        tokens: Math.round(4_300_000 * scale),
      },
      {
        channel: 'agent',
        conversations: 1,
        turns: Math.round(29 * scale),
        tokens: Math.round(1_900_000 * scale),
      },
      {
        channel: 'learning',
        conversations: 1,
        turns: Math.round(15 * scale),
        tokens: Math.round(380_000 * scale),
      },
    ],
    tools: [
      { name: 'web_search', calls: Math.round(212 * scale), failed: 3 },
      { name: 'read_memories', calls: Math.round(187 * scale), failed: 0 },
      { name: 'run_command', calls: Math.round(143 * scale), failed: 9 },
      { name: 'send_session_message', calls: Math.round(64 * scale), failed: 1 },
      { name: 'fetch_url', calls: Math.round(58 * scale), failed: 4 },
      { name: 'remember', calls: Math.round(41 * scale), failed: 0 },
      { name: 'create_schedule', calls: Math.round(12 * scale), failed: 0 },
      { name: 'send_sticker', calls: Math.round(9 * scale), failed: 0 },
    ],
  };
};
