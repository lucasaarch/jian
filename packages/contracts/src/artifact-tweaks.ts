import { z } from 'zod';

/**
 * A React component's tweaks, as its frame says them (ARTIFACT_TWEAKS_MESSAGE): what the
 * component exports as `tweaks`, by the name of the prop each one sets. A tweak is written in
 * full, `size: { type: 'number', label: 'Size', default: 16, min: 8, max: 64 }`, or as its
 * default alone, `size: 16`, its type then read from that: a boolean, a number, a colour (a #hex)
 * or a text. A list of `options` makes it a choice.
 *
 * What the frame says was written by an agent and runs in the frame, so the panel reads it as
 * display data and nothing more: bounded in number and size, and a tweak that does not fit is
 * left out rather than failing the rest.
 */

/** The most tweaks one component shows; the rest are left out. */
export const ARTIFACT_TWEAKS_LIMIT = 30;

const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
// A prop's name, as a component reads it; never one that reaches an object's prototype.
const KEY = /^[A-Za-z_$][\w$]{0,40}$/;
const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);
// What an agent may call a type, by habit from other tools.
const ALIASES: Record<string, string> = {
  string: 'text',
  bool: 'boolean',
  toggle: 'boolean',
  switch: 'boolean',
  range: 'number',
  slider: 'number',
  enum: 'select',
  radio: 'select',
  colour: 'color',
};

const label = z.string().trim().min(1).max(60).optional();
const choice = z.union([z.string().max(200), z.number()]);
const option = z.union([
  choice.transform((value) => ({ value, label: String(value) })),
  z.object({ value: choice, label: z.string().trim().min(1).max(60) }),
]);

const tweakSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), label, default: z.string().max(2000).default('') }),
  z.object({
    type: z.literal('number'),
    label,
    default: z.number().default(0),
    min: z.number().optional(),
    max: z.number().optional(),
    step: z.number().positive().optional(),
  }),
  z.object({ type: z.literal('boolean'), label, default: z.boolean().default(false) }),
  z.object({ type: z.literal('color'), label, default: z.string().regex(HEX).default('#000000') }),
  z.object({
    type: z.literal('select'),
    label,
    options: z.array(option).min(1).max(ARTIFACT_TWEAKS_LIMIT),
    default: choice.optional(),
  }),
]);

type Spelled = z.output<typeof tweakSchema>;
export type ArtifactTweakValue = string | number | boolean;
export type ArtifactTweak = { key: string; label: string } & (
  | Exclude<Spelled, { type: 'select' }>
  | (Extract<Spelled, { type: 'select' }> & { default: string | number })
);

const typeOf = (value: unknown) =>
  typeof value === 'boolean'
    ? 'boolean'
    : typeof value === 'number'
      ? 'number'
      : typeof value === 'string' && HEX.test(value)
        ? 'color'
        : 'text';

/** One tweak as written, with its type said: given, by another name, or read from its default. */
function spelled(written: unknown): unknown {
  if (written === null || typeof written !== 'object' || Array.isArray(written)) {
    return { type: typeOf(written), default: written };
  }
  const given = written as Record<string, unknown>;
  if (typeof given.type === 'string') return { ...given, type: ALIASES[given.type] ?? given.type };
  return { ...given, type: Array.isArray(given.options) ? 'select' : typeOf(given.default) };
}

/** `accentColor` and `accent_color` both read as "Accent color". */
const named = (key: string) => {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_$]+/g, ' ')
    .trim()
    .toLowerCase();
  return words ? words[0]?.toUpperCase() + words.slice(1) : key;
};

/** The tweaks a frame said, as the panel draws them; none for anything that is not a list of them. */
export function artifactTweaks(said: unknown): ArtifactTweak[] {
  if (said === null || typeof said !== 'object' || Array.isArray(said)) return [];
  const tweaks: ArtifactTweak[] = [];

  for (const [key, written] of Object.entries(said).slice(0, ARTIFACT_TWEAKS_LIMIT)) {
    if (!KEY.test(key) || UNSAFE.has(key)) continue;
    const read = tweakSchema.safeParse(spelled(written));
    if (!read.success) continue;
    const tweak = read.data;
    const base = { key, label: tweak.label ?? named(key) };
    if (tweak.type === 'select') {
      const first = tweak.options[0]?.value ?? '';
      const fits = tweak.options.some((one) => one.value === tweak.default);
      tweaks.push({ ...tweak, ...base, default: fits ? (tweak.default ?? first) : first });
    } else {
      tweaks.push({ ...tweak, ...base });
    }
  }
  return tweaks;
}

/** Whether a value is one this tweak can hold, as one kept from before has to be. */
export function artifactTweakFits(tweak: ArtifactTweak, value: unknown): boolean {
  switch (tweak.type) {
    case 'text':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'color':
      return typeof value === 'string' && HEX.test(value);
    case 'select':
      return tweak.options.some((one) => one.value === value);
  }
}
