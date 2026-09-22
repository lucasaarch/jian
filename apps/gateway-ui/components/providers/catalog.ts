import type { ProfileData, ProviderModel, ReasoningEffort } from '../../lib/api';

/** The vendors the panel offers, and the host variable each one reads when no key is saved. */
export const providers = [
  {
    kind: 'openrouter',
    name: 'OpenRouter',
    variables: 'OPENROUTER_API_KEY',
  },
  {
    kind: 'anthropic',
    name: 'Anthropic',
    variables: 'ANTHROPIC_API_KEY ou ANTHROPIC_API_TOKEN',
  },
  { kind: 'google', name: 'Gemini', variables: 'GEMINI_API_TOKEN' },
  { kind: 'openai', name: 'OpenAI', variables: 'OPENAI_API_KEY' },
] as const;

/**
 * The activities that can pin a model. `runtime: false` is deliberate and visible: the gateway
 * stores and validates the choice, and nothing executes it yet.
 */
export const roles = [
  {
    key: 'conversation',
    label: 'Conversations',
    hint: 'Used by the API when a request names no model.',
    runtime: true,
  },
  {
    key: 'channel',
    label: 'Channels',
    hint: 'WhatsApp, Telegram and webhooks. Unset, it follows the conversation default.',
    runtime: true,
  },
  {
    key: 'compaction',
    label: 'Context compaction',
    hint: 'Will summarise the history when a conversation outgrows its budget.',
    runtime: false,
  },
  {
    key: 'image',
    label: 'Image generation',
    hint: 'The model that will produce images when the agent asks for one.',
    runtime: false,
  },
  {
    key: 'audio',
    label: 'Audio generation',
    hint: 'The model that will produce sound that is not speech.',
    runtime: false,
  },
  {
    key: 'speech',
    label: 'Text to speech',
    hint: 'The model that will read a written answer aloud.',
    runtime: false,
  },
  {
    key: 'transcription',
    label: 'Speech to text',
    hint: 'The model that will transcribe audio arriving on a channel.',
    runtime: false,
  },
] as const;

export type Role = (typeof roles)[number]['key'];

export const efforts: Array<{ value: ReasoningEffort; label: string }> = [
  { value: 'none', label: 'No reasoning' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

/** A live provider carries its own key: revoking it takes the key with it. */
export const usableProviders = (data: ProfileData) =>
  data.providers.filter((provider) => !provider.revokedAt);

export const modelLabel = (model: ProviderModel) =>
  `${model.displayName ?? model.id}${model.known ? '' : ' · capabilities unknown'}`;
