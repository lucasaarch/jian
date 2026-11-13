import { toast } from 'sonner';
import { type InspectorTab, useCrew } from '../../../lib/stores/crew';
import type { TerminalApi } from './link';
import { expectedSize, shownTerminal } from './screen';

type Here = { api: TerminalApi; profileId: string };

/**
 * The agent whose conversation is on screen, and the way to its gateway. The Inspector's own
 * frame knows neither: the terminal drawer, drawn with the conversation, says them here. The
 * last one said is kept after its conversation leaves the screen, to end what it left open.
 */
let here: Here | undefined;
/** Whether a drawer is there to draw a terminal: without one a new tab would stay blank. */
let drawn = false;
let opening = false;

export function terminalsHere(context: Here) {
  here = context;
  drawn = true;

  return () => {
    if (here === context) drawn = false;
  };
}

/** "Terminal", then "Terminal 2" and on, in the order of their tabs. */
export function terminalLabel(tabs: InspectorTab[], tab: InspectorTab) {
  const at = tabs
    .filter((item) => item.kind === 'terminal')
    .findIndex((item) => item.key === tab.key);

  return at > 0 ? `Terminal ${at + 1}` : 'Terminal';
}

/**
 * Opens a shell on the gateway's machine, beside the conversation on screen, and its tab.
 * `replaces` is the key of an ended terminal's tab: the new one takes its place.
 */
export async function openTerminalTab(replaces?: string) {
  if (opening) return;
  if (!here || !drawn) {
    toast.error('Open a conversation to open a terminal beside it.');
    return;
  }

  const { api, profileId } = here;
  const { sessionId, tabs } = useCrew.getState();
  const old = tabs.find((tab) => tab.key === replaces);
  const ended = old?.kind === 'terminal' ? shownTerminal(old.terminalId) : undefined;

  opening = true;
  try {
    const terminal = await api.openTerminal(profileId, {
      ...(sessionId ? { sessionId } : {}),
      // The size the ended one had on screen is the size its tab still has.
      ...(ended?.size() ?? expectedSize()),
    });

    // The owner moved to another conversation while it opened: no tab there is waiting for it.
    if (useCrew.getState().sessionId !== sessionId) {
      void api.closeTerminal(profileId, terminal.id).catch(() => {});
      return;
    }
    useCrew.getState().openTerminal(terminal.id, replaces);
  } catch (error) {
    toast.error(error instanceof Error ? error.message : 'The terminal could not be opened.');
  } finally {
    opening = false;
  }
}

/** Whether a key was pressed in a terminal, which reads Escape and the rest itself. */
export const inTerminal = (target: EventTarget | null) =>
  target instanceof Element && Boolean(target.closest('[data-terminal]'));

// A terminal lives as long as its tab. One whose tab the owner closed, or gave to a new shell,
// ends on the gateway: one already gone is as closed as it gets. A conversation left for another
// keeps its tabs, saved for its return, and its shells go on. A new chat's are saved nowhere
// until its first message, so a terminal opened there and left behind ends too, instead of
// holding one of the gateway's places.
useCrew.subscribe((state, previous) => {
  if (state.tabs === previous.tabs) return;
  if (previous.sessionId && state.sessionId !== previous.sessionId) return;

  for (const tab of previous.tabs) {
    if (tab.kind === 'terminal' && !state.tabs.some((kept) => kept.key === tab.key))
      void here?.api.closeTerminal(here.profileId, tab.terminalId).catch(() => {});
  }
});
