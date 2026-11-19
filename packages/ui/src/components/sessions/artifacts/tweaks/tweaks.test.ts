import { ARTIFACT_TWEAKS_LIMIT, artifactTweakFits, artifactTweaks } from '@jian/contracts';
import { describe, expect, it } from 'vitest';

// What a component's frame says is written by an agent: read as data, and only what fits.
describe("a component's tweaks, as the panel reads them", () => {
  it('reads a tweak written as its default alone, or with a type by another name', () => {
    expect(
      artifactTweaks({
        title: 'Hello',
        count: 3,
        rounded: true,
        accentColor: '#7c3aed',
        size: { type: 'slider', min: 8, max: 64, default: 16 },
        tone: { options: ['calm', { value: 2, label: 'Loud' }], default: 'missing' },
      }),
    ).toEqual([
      { key: 'title', label: 'Title', type: 'text', default: 'Hello' },
      { key: 'count', label: 'Count', type: 'number', default: 3 },
      { key: 'rounded', label: 'Rounded', type: 'boolean', default: true },
      { key: 'accentColor', label: 'Accent color', type: 'color', default: '#7c3aed' },
      { key: 'size', label: 'Size', type: 'number', min: 8, max: 64, default: 16 },
      {
        key: 'tone',
        label: 'Tone',
        type: 'select',
        options: [
          { value: 'calm', label: 'calm' },
          { value: 2, label: 'Loud' },
        ],
        // A default that is none of its options is its first.
        default: 'calm',
      },
    ]);
  });

  it('leaves out what does not fit, and keeps the rest', () => {
    expect(
      artifactTweaks({
        'not a prop': 'x',
        constructor: 'x',
        tooLong: 'x'.repeat(2001),
        badColor: { type: 'color', default: 'red' },
        unknown: { type: 'video' },
        kept: 'yes',
      }).map((tweak) => tweak.key),
    ).toEqual(['kept']);
    for (const said of [null, 'tweaks', [1, 2], 7]) expect(artifactTweaks(said)).toEqual([]);

    const many = Object.fromEntries(Array.from({ length: 50 }, (_, index) => [`t${index}`, 1]));
    expect(artifactTweaks(many)).toHaveLength(ARTIFACT_TWEAKS_LIMIT);
  });

  it('keeps a value set before only while its tweak still takes it', () => {
    const [size, tone] = artifactTweaks({ size: 4, tone: { options: ['a', 'b'] } });
    if (!size || !tone) throw new Error('Both tweaks are read.');

    expect(artifactTweakFits(size, 9)).toBe(true);
    expect(artifactTweakFits(size, '9')).toBe(false);
    expect(artifactTweakFits(size, Number.NaN)).toBe(false);
    expect(artifactTweakFits(tone, 'b')).toBe(true);
    expect(artifactTweakFits(tone, 'c')).toBe(false);
  });
});
