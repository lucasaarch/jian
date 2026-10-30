import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { createGateway } from './gateway.js';
import { LocalExecutor } from './runs/executors.js';
import { SecretBox } from './security/crypto.js';
import { startupFailure } from './startup.js';
import { PGliteStore } from './storage/pglite.js';

/**
 * The gateway a desktop app runs for its owner, on their own computer: its database is a
 * directory, its runs execute in this process, it listens on loopback only, and it has no
 * channels, since the computer is not always on to receive them. The app starts it with this
 * configuration and reads one line on stdout, `{"listening":"http://127.0.0.1:<port>"}`.
 */
/** The channel to the Electron app that started this process; absent anywhere else. */
type ParentPort = { on(event: 'message', listener: (message: { data: unknown }) => void): void };

const config = z
  .object({
    /** Where the database and the agents' workspaces live; the app's data directory. */
    JIAN_LOCAL_DIR: z.string().min(1),
    JIAN_API_TOKEN: z.string().min(32),
    /** One 32-byte key, base64: the app keeps it in the system's keychain. */
    JIAN_MASTER_KEY: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
    /** 0 lets the system choose a free port, which the line on stdout names. */
    PORT: z.coerce.number().int().min(0).max(65535).default(0),
    JIAN_ALLOW_PRIVATE_ORIGINS: z.string().default(''),
  })
  .safeParse(process.env);

if (!config.success) {
  console.error(
    'The local gateway configuration is incomplete:',
    config.error.issues.map((issue) => issue.path.join('.')).join(', '),
  );
  process.exit(1);
}

const dir = config.data.JIAN_LOCAL_DIR;
await mkdir(join(dir, 'database'), { recursive: true });
// The agents' workspaces stay with the rest of the app's data, not in the owner's home.
process.env.JIAN_WORKSPACES ||= join(dir, 'workspaces');

const gateway = await createGateway({
  store: await PGliteStore.open(join(dir, 'database')),
  box: new SecretBox({
    activeKeyId: 'local',
    keys: { local: Buffer.from(config.data.JIAN_MASTER_KEY, 'base64') },
  }),
  token: config.data.JIAN_API_TOKEN,
  role: 'all',
  executor: new LocalExecutor(),
  channels: 'none',
  allowPrivateOrigins: config.data.JIAN_ALLOW_PRIVATE_ORIGINS.split(',')
    .map((value) => value.trim())
    .filter(Boolean),
  trustedProxies: [],
  // Schedules read their hours in the owner's own zone, which is this computer's.
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
});

const stop = () => void gateway.stop().finally(() => process.exit(0));
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
// Run by the desktop app as an Electron utility process, it is asked to stop by a message:
// Windows has no SIGTERM, and a hard kill could cut the database mid-write.
const parentPort = (process as { parentPort?: ParentPort }).parentPort;
parentPort?.on('message', ({ data }) => {
  if ((data as { stop?: unknown } | null)?.stop === true) stop();
});

try {
  const { url } = await gateway.start({ host: '127.0.0.1', port: config.data.PORT });
  process.stdout.write(`${JSON.stringify({ listening: url })}\n`);
} catch (error) {
  console.error(startupFailure(gateway.stage(), error));
  await gateway.stop().catch(() => {});
  process.exit(1);
}
