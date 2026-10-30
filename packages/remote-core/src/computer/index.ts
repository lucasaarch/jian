/**
 * Computer Use on whatever OS this is: the capability this machine advertises, and the
 * backend that runs its tasks, loaded only on the platform it serves.
 */
import type { RemoteResult, RemoteTask } from '@jian/contracts';
import { failed } from './outcome.ts';
import { capabilityForPlatform, isComputerCapability } from './shared.ts';

export {
  COMPUTER_CAPABILITIES,
  type ComputerCapability,
  capabilityForPlatform,
  imagePixelToPoint,
  isComputerCapability,
  scaleFromGeometry,
} from './shared.ts';
export { isComputerCapability as workerSupportsComputerCapability };

type ComputerBackend = {
  executeComputerTask(task: RemoteTask): Promise<RemoteResult>;
  probeComputerCapability(): Promise<boolean>;
  materializeComputerHelperSources(configDir: string): Promise<void>;
};

async function loadBackend(): Promise<ComputerBackend | null> {
  switch (process.platform) {
    case 'darwin':
      return import('./macos.ts');
    case 'linux':
      return import('./linux.ts');
    case 'win32':
      return import('./windows.ts');
    default:
      return null;
  }
}

export async function executeComputerTask(task: RemoteTask): Promise<RemoteResult> {
  const backend = await loadBackend();
  if (!backend) {
    return {
      taskId: task.id,
      ...failed(`Computer use is not supported on platform ${process.platform}.`),
    };
  }
  return backend.executeComputerTask(task);
}

export async function probeComputerCapability(): Promise<boolean> {
  const backend = await loadBackend();
  return backend ? backend.probeComputerCapability() : false;
}

/** The capability this platform would advertise; undefined where there is no backend. */
export function computerCapabilityName(): string | undefined {
  return capabilityForPlatform(process.platform) ?? undefined;
}

/** Copies the native helpers next to the installed worker, so it runs without the package. */
export async function materializeComputerHelperSources(configDir: string): Promise<void> {
  await (await loadBackend())?.materializeComputerHelperSources(configDir);
}
