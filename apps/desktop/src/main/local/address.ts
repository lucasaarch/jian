import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { app } from 'electron';

const file = () => join(app.getPath('userData'), 'local-gateway-address.json');

/** Whether nothing listens on `port` of loopback right now. */
function free(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
  });
}

/** A port the system says is free, chosen by asking it for any. */
function anyFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() =>
        address && typeof address === 'object' ? resolve(address.port) : reject(),
      );
    });
  });
}

/**
 * The local gateway's port, the same from launch to launch: GitHub keeps the gateway's address in
 * the App it registered, and MCP servers send sign-ins back to it. Chosen once; chosen again only
 * when something else took it, which `moved` says, as those sign-ins then need doing again.
 */
export async function stablePort(): Promise<{ port: number; moved: boolean }> {
  let saved: number | undefined;
  try {
    saved = (JSON.parse(await readFile(file(), 'utf8')) as { port?: number }).port;
  } catch {
    saved = undefined;
  }
  if (saved && (await free(saved))) return { port: saved, moved: false };
  const port = await anyFreePort();
  await writeFile(file(), `${JSON.stringify({ port }, null, 2)}\n`, { mode: 0o600 });
  return { port, moved: saved !== undefined };
}
