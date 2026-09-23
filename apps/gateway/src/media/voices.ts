import type { ModelConfig } from '@jian/contracts';

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
  throw new Error('Speech requires a Gemini or OpenAI API model, not a subscription login');
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
