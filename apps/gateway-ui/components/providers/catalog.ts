import type { ProfileData, ProviderModel, ReasoningEffort } from '../../lib/api';

/** The vendors the panel offers, each with what it is and the host variable it falls back to. */
export const providers = [
  {
    kind: 'openrouter',
    name: 'OpenRouter',
    description: 'One account, many models.',
    symbol: '⇄',
    variables: 'OPENROUTER_API_KEY',
  },
  {
    kind: 'anthropic',
    name: 'Anthropic',
    description: 'Claude models for your agents.',
    symbol: 'A',
    variables: 'ANTHROPIC_API_KEY or ANTHROPIC_API_TOKEN',
  },
  {
    kind: 'google',
    name: 'Gemini',
    description: "Google's Gemini models.",
    symbol: '✦',
    variables: 'GEMINI_API_TOKEN',
  },
  {
    kind: 'openai',
    name: 'OpenAI',
    description: 'The OpenAI API, or your ChatGPT account.',
    symbol: '◎',
    variables: 'OPENAI_API_KEY',
  },
] as const;

/**
 * Anthropic issues two credentials and they are not interchangeable, so the owner says which
 * one they pasted rather than the gateway guessing and answering 401 on every run.
 */
export const anthropicCredentials = [
  { value: 'key', label: 'API key', detail: 'Starts with sk-ant-api. Billed per token.' },
  {
    value: 'subscription',
    label: 'Subscription token',
    detail: 'From claude setup-token. Uses your Claude plan.',
  },
] as const;

/**
 * Each activity selects a model independently; empty selections use the stated fallback.
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
    hint: 'Summarises older context automatically or when the agent requests it. Unset, it uses the conversation model.',
    runtime: true,
  },
  {
    key: 'image',
    label: 'Image generation',
    hint: 'Generates images with an OpenAI API key or Gemini. Unset, it uses Gemini when configured.',
    runtime: true,
  },
  {
    key: 'vision',
    label: 'Image analysis',
    hint: 'When selected, analyzes incoming images. Otherwise the conversation model sees them directly when supported; Gemini is the fallback.',
    runtime: true,
  },
  {
    key: 'audio',
    label: 'Audio analysis',
    hint: 'Understands speech and sounds in audio files. Unset, it uses Gemini.',
    runtime: true,
  },
  {
    key: 'speech',
    label: 'Text to speech',
    hint: 'Generates voice replies with OpenAI or Gemini. Unset, it uses Gemini with the Kore voice.',
    runtime: true,
  },
  {
    key: 'transcription',
    label: 'Speech to text',
    hint: 'Transcribes incoming voice notes. Unset, it uses Gemini.',
    runtime: true,
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
