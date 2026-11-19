'use client';

import { PanelRight } from 'lucide-react';
import { HoverTip, iconButton } from '../../kit';
import { useCrew } from '../../lib/stores/crew';
import { useStageShowing } from '../../lib/stores/onboarding';
import { useInspectorAway } from '../../lib/stores/screen';

/**
 * The way to open the Inspector while it is closed, at the window's top right: where the open
 * Inspector keeps its close button, in its size and hover, so it is one button whether the
 * Inspector is open or not. Centred in a 2.5rem bar, the Inspector's row of tabs. Every host
 * draws it in the same place; it stands clear of the window's own buttons a host draws there.
 *
 * It is gone while there is nothing to open it beside: the Inspector already open, a screen in
 * the conversation's place (pull requests, Artifacts, settings), or a whole-window scene. Opened
 * with no tab, the Inspector shows what it can hold, Artifacts among them, with or without one
 * made in this conversation (inspector-host.tsx).
 */
export function InspectorOpener() {
  const opened = useCrew((state) => state.opened);
  const away = useInspectorAway();
  const staged = useStageShowing();

  if (opened || away || staged) return null;

  return (
    <HoverTip tip="Open inspector" hoverOnly side="bottom" align="end">
      <button
        type="button"
        aria-label="Open inspector"
        onClick={() => useCrew.getState().reopen()}
        className={`absolute top-1.5 right-[calc(var(--window-controls,0px)+var(--inspector-inset))] z-30 ${iconButton}`}
      >
        <PanelRight size={15} aria-hidden="true" />
      </button>
    </HoverTip>
  );
}
