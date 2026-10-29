'use client';

import { useId } from 'react';
import { type OrbSize, type OrbState, ThinkingOrb } from 'thinking-orbs';
import { useAppearance } from '../../lib/appearance';

/**
 * The thinking orb, drawn in the panel's accent. The library only inks in grey, so it draws in
 * light ink and a filter keeps each dot's brightness as its opacity and fills it with the
 * accent: the depth of the animation survives in the monochrome palette.
 */
export function Orb({
  state = 'composing',
  size = 20,
  paused = false,
}: {
  state?: OrbState;
  size?: OrbSize;
  /** Held still, as the mark of work that has ended. */
  paused?: boolean;
}) {
  const { still } = useAppearance();
  const filter = useId().replace(/:/g, '');

  return (
    <span className="orb" style={{ width: size, height: size }} aria-hidden="true">
      <svg width="0" height="0" focusable="false" aria-hidden="true">
        <filter id={filter} colorInterpolationFilters="sRGB">
          <feColorMatrix
            type="matrix"
            values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0.2126 0.7152 0.0722 0 0"
            result="ink"
          />
          <feFlood className="orb-accent" />
          <feComposite in2="ink" operator="in" />
        </filter>
      </svg>
      <ThinkingOrb
        state={state}
        size={size}
        theme="dark"
        paused={still || paused}
        style={{ filter: `url(#${filter})` }}
      />
    </span>
  );
}
