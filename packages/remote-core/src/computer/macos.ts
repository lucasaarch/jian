/**
 * Computer Use on macOS: screencapture for screenshots, and a Swift helper that draws the Jian
 * pointer and drives input. The worker also loads this module alone, for its power assertion
 * and the screen state it reports to the gateway.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { RemoteResult, RemoteTask } from '@jian/contracts';
import type { HelperChannel } from './helper-channel.ts';
import { ensureHelperBinary, helperPaths } from './macos/helper.ts';
import { holdSessionDisplay, releaseSessionDisplay } from './macos/power.ts';
import { capturePrimaryScreenshotBase64 } from './macos/screenshot.ts';
import { prepareMacAction } from './macos/ui-state.ts';
import { ComputerSession, type Screenshot } from './session.ts';
import { COMPUTER_CAPABILITIES } from './shared.ts';
import { runComputerTask } from './task.ts';

export { materializeComputerHelperSources, packageHelperPaths } from './macos/helper.ts';
export {
  startWorkerIdleAssertion,
  stopWorkerIdleAssertion,
  wakeMacDisplay,
} from './macos/power.ts';
export { capturePrimaryScreenshotBase64 } from './macos/screenshot.ts';
export {
  MAC_UI_STATES,
  type MacUiState,
  prepareComputerUi,
  probeMacUiState,
} from './macos/ui-state.ts';
export { imagePixelToPoint, scaleFromGeometry } from './shared.ts';

export const COMPUTER_CAPABILITY = COMPUTER_CAPABILITIES.darwin;

/**
 * The Rust helper prototype (packages/remote-core/native), when this names its binary. It
 * captures in-process, so screenshots go through it instead of screencapture and sips.
 */
const rustHelper = process.env.JIAN_COMPUTER_HELPER;

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
      return spawn(rustHelper || (await ensureHelperBinary()), [], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    },
    capture: rustHelper ? captureWithHelper : capturePrimaryScreenshotBase64,
    prepare: prepareMacAction,
    hold: holdSessionDisplay,
    release: releaseSessionDisplay,
  });
  return sharedSession;
}

export function executeComputerTask(task: RemoteTask): Promise<RemoteResult> {
  return runComputerTask(computerSession(), task);
}

/** Whether this Mac can offer Computer Use: its helper is installed, or swiftc can build it. */
export async function probeComputerCapability(): Promise<boolean> {
  if (process.platform !== 'darwin') return false;
  try {
    await ensureHelperBinary();
    return true;
  } catch {
    return (
      Boolean(spawnSync('which', ['swiftc'], { encoding: 'utf8' }).stdout?.trim()) ||
      existsSync(helperPaths().binary)
    );
  }
}
