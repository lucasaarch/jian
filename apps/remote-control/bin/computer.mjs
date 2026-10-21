/**
 * Platform router for Jian Remote computer use.
 * Advertises computer-{macos,linux,windows}-v1 and dispatches to the OS backend.
 */
import { capabilityForPlatform, isComputerCapability } from './computer-shared.mjs';

export {
  COMPUTER_CAPABILITIES,
  capabilityForPlatform,
  imagePixelToPoint,
  isComputerCapability,
  scaleFromGeometry,
} from './computer-shared.mjs';

async function loadBackend() {
  switch (process.platform) {
    case 'darwin':
      return import('./computer-macos.mjs');
    case 'linux':
      return import('./computer-linux.mjs');
    case 'win32':
      return import('./computer-windows.mjs');
    default:
      return null;
  }
}

export async function executeComputerTask(task) {
  const backend = await loadBackend();
  if (!backend) {
    return {
      taskId: task.id,
      exitCode: 1,
      stdout: '',
      stderr: `Computer use is not supported on platform ${process.platform}.`,
      timedOut: false,
      computer: {
        ok: false,
        error: `Computer use is not supported on platform ${process.platform}.`,
      },
    };
  }
  return backend.executeComputerTask(task);
}

export async function probeComputerCapability() {
  const backend = await loadBackend();
  if (!backend) return false;
  return backend.probeComputerCapability();
}

export function computerCapabilityName() {
  return capabilityForPlatform(process.platform);
}

export async function materializeComputerHelperSources(configDir) {
  const backend = await loadBackend();
  if (backend?.materializeComputerHelperSources) {
    await backend.materializeComputerHelperSources(configDir);
  }
}

export { isComputerCapability as workerSupportsComputerCapability };
