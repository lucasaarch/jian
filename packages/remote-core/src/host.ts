/**
 * How the worker is named to the owner, and what to do to update or restart it, as the host it
 * runs in says it: the CLI's service by default, the native app when it runs the worker itself.
 * Read when a message is written, so a host sets it once before the worker starts.
 */
export type HostWording = {
  /** "Jian Remote", or the app's own name. */
  name: string;
  /** What to do to run the release `version` this gateway requires. */
  update: (version: string) => string;
  /** What to do when the worker cannot recover by itself. */
  restart: string;
};

let wording: HostWording = {
  name: 'Jian Remote',
  update: (version) => `run: jian-remote update --version ${version}`,
  restart: 'Restart the Jian Remote service or re-run install',
};

export const hostWording = (): HostWording => wording;

export function setHostWording(next: HostWording): void {
  wording = next;
}
