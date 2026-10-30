/**
 * Computer Use on macOS: the Rust helper (packages/remote-core/native) captures the screen,
 * draws the Jian pointer and drives input. The worker also loads this module alone, for its
 * power assertion and the screen state it reports to the gateway.
 */
import { spawn } from 'node:child_process';
import type { RemoteResult, RemoteTask } from '@jian/contracts';
import type { HelperChannel } from './helper-channel.ts';
import { ensureHelperBinary } from './macos/helper.ts';
import { holdSessionDisplay, releaseSessionDisplay } from './macos/power.ts';
import { prepareMacAction } from './macos/ui-state.ts';
import { ComputerSession, type Screenshot } from './session.ts';
import { COMPUTER_CAPABILITIES } from './shared.ts';
import { runComputerTask } from './task.ts';

export { materializeComputerHelperSources, packagedHelper } from './macos/helper.ts';
export {
  startWorkerIdleAssertion,
  stopWorkerIdleAssertion,
  wakeMacDisplay,
} from './macos/power.ts';
export {
  MAC_UI_STATES,
  type MacUiState,
  prepareComputerUi,
  probeMacUiState,
} from './macos/ui-state.ts';
export { imagePixelToPoint, scaleFromGeometry } from './shared.ts';

export const COMPUTER_CAPABILITY = COMPUTER_CAPABILITIES.darwin;

/** The helper captures in-process and fits the JPEG to the worker channel itself. */
async function captureWithHelper(channel: HelperChannel): Promise<Screenshot> {
  const reply = await channel.call({ cmd: 'screenshot' }, 'Screenshot failed');
  const { base64, widthPx, heightPx } = reply;
  if (typeof base64 !== 'string' || typeof widthPx !== 'number' || typeof heightPx !== 'number') {
    throw new Error('Screenshot produced no image data.');
  }
  return { base64, widthPx, heightPx };
}

let sharedSession: ComputerSession | null = null;

export function computerSession(): ComputerSession {
  sharedSession ??= new ComputerSession({
    async launch() {
      return spawn(await ensureHelperBinary(), [], { stdio: ['pipe', 'pipe', 'pipe'] });
    },
    capture: captureWithHelper,
    prepare: prepareMacAction,
    hold: holdSessionDisplay,
    release: releaseSessionDisplay,
  });
  return sharedSession;
}

export function executeComputerTask(task: RemoteTask): Promise<RemoteResult> {
  return runComputerTask(computerSession(), task);
}

/** Whether this Mac can offer Computer Use: the package ships its helper, or one is installed. */
export async function probeComputerCapability(): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  try {
    await ensureHelperBinary();
    return true;
  } catch {
    return false;
  }
}
