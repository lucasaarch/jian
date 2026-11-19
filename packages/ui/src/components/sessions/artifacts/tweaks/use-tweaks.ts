'use client';

import {
  ARTIFACT_TWEAKS_MESSAGE,
  type ArtifactTweak,
  type ArtifactTweakValue,
  artifactTweakFits,
  artifactTweaks,
} from '@jian/contracts';
import { type RefObject, useEffect, useState } from 'react';

/** The theme a component is tried in: the panel's, or one of its own. */
export type TweakScheme = 'auto' | 'light' | 'dark';
type Values = Record<string, ArtifactTweakValue>;

const defaults = (tweaks: ArtifactTweak[]): Values =>
  Object.fromEntries(tweaks.map((tweak) => [tweak.key, tweak.default]));

/**
 * A React component's tweaks, between the panel and the frame that draws it (artifact-frame.tsx).
 * The frame says what the component declares once it is drawn, and again whenever it is drawn
 * anew (another version, back from its code); it is answered with every value the panel shows,
 * so the component is drawn with exactly those. Values set by the owner are kept across that
 * while their tweak still takes them, and are never saved: they are for trying it out.
 *
 * Only the frame this view holds is heard, and what it says is checked (artifact-tweaks.ts in
 * the contracts) before anything is drawn from it.
 */
export function useTweaks(frame: RefObject<HTMLIFrameElement | null>, on: boolean) {
  // Null until the frame has said; a component that declares none says an empty list.
  const [tweaks, setTweaks] = useState<ArtifactTweak[] | null>(null);
  const [values, setValues] = useState<Values>({});
  const [scheme, setScheme] = useState<TweakScheme>('auto');

  useEffect(() => {
    if (!on) return;
    const hear = (event: MessageEvent) => {
      const held = frame.current?.contentWindow;
      if (!held || event.source !== held) return;
      const said = (event.data as Record<string, unknown> | null)?.[ARTIFACT_TWEAKS_MESSAGE];
      if (!said || typeof said !== 'object' || !('controls' in said)) return;
      const next = artifactTweaks(said.controls);
      setTweaks(next);
      setValues((kept) => {
        const fresh = defaults(next);
        for (const tweak of next) {
          const value = kept[tweak.key];
          if (artifactTweakFits(tweak, value)) fresh[tweak.key] = value as ArtifactTweakValue;
        }
        return fresh;
      });
    };
    window.addEventListener('message', hear);
    return () => window.removeEventListener('message', hear);
  }, [frame, on]);

  useEffect(() => {
    if (!tweaks) return;
    // A sealed frame's origin cannot be named; what goes is only these values.
    frame.current?.contentWindow?.postMessage({ [ARTIFACT_TWEAKS_MESSAGE]: { values } }, '*');
  }, [tweaks, values, frame]);

  const initial = tweaks ? defaults(tweaks) : {};
  return {
    tweaks,
    values,
    scheme,
    setScheme,
    set: (key: string, value: ArtifactTweakValue) => setValues((now) => ({ ...now, [key]: value })),
    changed:
      scheme !== 'auto' || Object.entries(values).some(([key, value]) => initial[key] !== value),
    reset: () => {
      setScheme('auto');
      setValues(initial);
    },
  };
}

export type Tweaks = ReturnType<typeof useTweaks>;
