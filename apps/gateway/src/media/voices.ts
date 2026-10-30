import type { ModelConfig } from '@jian/contracts';
import { XAI_BASE_URL } from '../providers/catalog.js';

/** xAI is reached as an OpenAI-compatible server at its own address. */
export const isXai = (config: ModelConfig) =>
  config.provider === 'openai-compatible' && config.baseURL === XAI_BASE_URL;

// https://docs.x.ai/developers/rest-api-reference/inference/voice (GET /v1/tts/voices)
const xaiVoices = [
  'eve',
  'ara',
  'leo',
  'rex',
  'sal',
  'carina',
  'zagan',
  'helix',
  'orion',
  'luna',
  'iris',
  'altair',
  'zenith',
  'perseus',
  'helios',
  'lux',
  'kepler',
  'rigel',
  'cosmo',
  'celeste',
  'ursa',
  'sirius',
  'lumen',
  'castor',
  'naksh',
  'atlas',
];

// https://ai.google.dev/gemini-api/docs/speech-generation#voice-options
const geminiVoices = [
  ['Zephyr', 'Bright'],
  ['Puck', 'Upbeat'],
  ['Charon', 'Informative'],
  ['Kore', 'Firm'],
  ['Fenrir', 'Excitable'],
  ['Leda', 'Youthful'],
  ['Orus', 'Firm'],
  ['Aoede', 'Breezy'],
  ['Callirrhoe', 'Easy-going'],
  ['Autonoe', 'Bright'],
  ['Enceladus', 'Breathy'],
  ['Iapetus', 'Clear'],
  ['Umbriel', 'Easy-going'],
  ['Algieba', 'Smooth'],
  ['Despina', 'Smooth'],
  ['Erinome', 'Clear'],
  ['Algenib', 'Gravelly'],
  ['Rasalgethi', 'Informative'],
  ['Laomedeia', 'Upbeat'],
  ['Achernar', 'Soft'],
  ['Alnilam', 'Firm'],
  ['Schedar', 'Even'],
  ['Gacrux', 'Mature'],
  ['Pulcherrima', 'Forward'],
  ['Achird', 'Friendly'],
  ['Zubenelgenubi', 'Casual'],
  ['Vindemiatrix', 'Gentle'],
  ['Sadachbia', 'Lively'],
  ['Sadaltager', 'Knowledgeable'],
  ['Sulafat', 'Warm'],
] as const;

// https://developers.openai.com/api/docs/guides/text-to-speech#voice-options
const openaiVoices = [
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'fable',
  'nova',
  'onyx',
  'sage',
  'shimmer',
  'verse',
  'marin',
  'cedar',
];
const legacyVoices = new Set([
  'alloy',
  'ash',
  'coral',
  'echo',
  'fable',
  'onyx',
  'nova',
  'sage',
  'shimmer',
]);

export function speechVoices(config: ModelConfig) {
  if (config.provider === 'google') {
    return {
      provider: 'Gemini',
      model: config.modelId,
      defaultVoice: 'Kore',
      supportsInstructions: true,
      voices: geminiVoices.map(([name, character]) => ({ name, character })),
    };
  }
  if (config.provider === 'openai') {
    const legacy = /^tts-1(?:-hd)?(?:-|$)/.test(config.modelId);
    return {
      provider: 'OpenAI',
      model: config.modelId,
      defaultVoice: 'nova',
      supportsInstructions: !legacy,
      voices: openaiVoices
        .filter((name) => !legacy || legacyVoices.has(name))
        .map((name) => ({ name })),
    };
  }
  if (isXai(config)) {
    return {
      provider: 'xAI',
      model: config.modelId,
      defaultVoice: 'eve',
      // Speech tags such as [pause] or <whisper> go inside the text; there is no style field.
      supportsInstructions: false,
      voices: xaiVoices.map((name) => ({ name })),
    };
  }
  throw new Error('Speech requires a Gemini, OpenAI or xAI API model, not a subscription login');
}

export function speechVoice(config: ModelConfig, requested?: string): string {
  const options = speechVoices(config);
  if (!requested) return options.defaultVoice;
  const voice = options.voices.find((v) => v.name.toLowerCase() === requested.trim().toLowerCase());
  if (voice) return voice.name;
  throw new Error(
    `Unsupported voice for ${options.provider} (${options.model}). Choose ${options.voices.map((v) => v.name).join(', ')}, or omit voice for ${options.defaultVoice}. Use list_speech_voices before choosing a voice.`,
  );
}
