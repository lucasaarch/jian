import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { hostWording } from '../../host.ts';
import type { ComputerAction, Preparation } from '../session.ts';
import { helperPaths } from './helper.ts';
import { wakeMacDisplay } from './power.ts';

/** The values the gateway accepts in `x-jian-remote-ui-state`. */
export const MAC_UI_STATES = Object.freeze([
  'unlocked',
  'locked',
  'display_asleep',
  'unknown',
] as const);

export type MacUiState = (typeof MAC_UI_STATES)[number];

/** How long a probe answers for, in ms: the worker asks on every poll, about once a second. */
const UI_STATE_CACHE_MS = 5_000;

let cached: { at: number; state: MacUiState } = { at: 0, state: 'unknown' };

function isMacUiState(value: unknown): value is MacUiState {
  return MAC_UI_STATES.some((state) => state === value);
}

/**
 * Unlocked, locked, or display asleep, as the installed helper reads it from CGSession and
 * CGDisplayIsAsleep. Anything it cannot tell is `unknown`, never a guess.
 */
export function probeMacUiState({ force = false }: { force?: boolean } = {}): MacUiState {
  if (process.platform !== 'darwin') return 'unknown';
  const now = Date.now();
  if (!force && now - cached.at < UI_STATE_CACHE_MS) return cached.state;
  cached = { at: now, state: readUiState() };
  return cached.state;
}

function readUiState(): MacUiState {
  const binary = helperPaths().binary;
  if (!existsSync(binary)) return 'unknown';
  const probed = spawnSync(binary, ['--session-status'], {
    encoding: 'utf8',
    timeout: 4_000,
    maxBuffer: 16_000,
  });
  if (probed.status !== 0) return 'unknown';
  try {
    const last = (probed.stdout || '').trim().split('\n').pop() || '{}';
    const parsed: unknown = JSON.parse(last);
    if (typeof parsed !== 'object' || parsed === null) return 'unknown';
    const { ok, state } = parsed as { ok?: unknown; state?: unknown };
    return ok && isMacUiState(state) ? state : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Wakes the display when it is locked or asleep — a lock often comes with display sleep. It
 * never blocks the action: the caller tries the OS next whatever the state.
 */
export function prepareComputerUi(): { sessionLocked: boolean; state: MacUiState } {
  let state = probeMacUiState({ force: true });
  if (state !== 'unlocked') {
    wakeMacDisplay(3);
    state = probeMacUiState({ force: true });
  }
  return { sessionLocked: state === 'locked', state };
}

const LOCKED_SCREENSHOT_NOTE =
  'Note: Mac session reports locked — image may be the lock screen (or black if the display stayed asleep). Desktop apps behind loginwindow are often not visible.';

const LOCKED_ACTION_HINT =
  ' Mac session reports locked; if this failed, unlock or keep the display awake (post-login lock ≠ FileVault loginwindow).';

/** Screenshots need Screen Recording; input needs Accessibility. Each failure names its own. */
function permissionHint(message: string, action: ComputerAction): string {
  if (action === 'screenshot') {
    return /accessib|not permitted|not authorized|Screen Recording/i.test(message)
      ? ` ${hostWording().name} needs Screen Recording (and Accessibility for input) in System Settings.`
      : '';
  }
  return /accessib|not permitted|not authorized/i.test(message)
    ? ` ${hostWording().name} needs Accessibility (and Screen Recording for screenshots) in System Settings.`
    : '';
}

/** What the agent is told about a locked screen and missing privacy permissions. */
export function prepareMacAction(): Preparation {
  const { sessionLocked } = prepareComputerUi();
  return {
    note: sessionLocked ? LOCKED_SCREENSHOT_NOTE : '',
    explain: (message, action) =>
      `${message}${permissionHint(message, action)}${sessionLocked ? LOCKED_ACTION_HINT : ''}`.trim(),
  };
}
