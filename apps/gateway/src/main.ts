import { timeZoneSchema } from '@jian/contracts';
import { PgBoss } from 'pg-boss';
import { z } from 'zod';
import { createGateway } from './gateway.js';
import { BossExecutor } from './runs/executors.js';
import { SecretBox } from './security/crypto.js';
import { startupFailure } from './startup.js';
import { PostgresStore } from './storage/postgres.js';

const config = z
  .object({
    DATABASE_URL: z.string().min(1),
    JIAN_ACTIVE_KEY_ID: z.string().min(1),
    JIAN_MASTER_KEYS: z.string().min(1),
    JIAN_ALLOW_PRIVATE_ORIGINS: z.string().default(''),
    JIAN_CAVEMAN_ENABLED: z.enum(['true', 'false']).default('false'),
    JIAN_CAVEMAN_PROXY_URL: z
      .string()
      .default('http://127.0.0.1:8788')
      .refine((value) => {
        if (!value) return true;
        try {
          const url = new URL(value);
          return (
            ['http:', 'https:'].includes(url.protocol) &&
            url.origin === value.replace(/\/$/, '') &&
            !url.username &&
            !url.password &&
            !url.search &&
            !url.hash
          );
        } catch {
          return false;
        }
      }, 'Use an exact HTTP(S) origin without credentials, path, query or fragment'),
    JIAN_API_TOKEN: z.string().min(32),
    HOST: z.string().default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4310),
    JIAN_ROLE: z.enum(['all', 'api', 'worker']).default('all'),
    JIAN_TIME_ZONE: z.union([timeZoneSchema, z.literal('')]).optional(),
    // Where a browser reaches this gateway. An MCP authorization server redirects the owner
    // back to it, so it has to be the public address rather than the listening one.
    JIAN_PUBLIC_URL: z.url().optional(),
    // The proxies allowed to state the client's address and scheme in X-Forwarded-*: the web
    // container above all. Comma-separated addresses, CIDR ranges, or `loopback`, `linklocal`
    // and `uniquelocal`. Empty, the socket peer is the client, as when nothing sits in front.
    JIAN_TRUSTED_PROXIES: z.string().default(''),
  })
  .safeParse(process.env);

if (!config.success) {
  console.error(
    'Jian configuration is incomplete:',
    config.error.issues.map((i) => i.path.join('.')).join(', '),
  );

  process.exit(1);
}

const store = new PostgresStore(config.data.DATABASE_URL);
let box: SecretBox;

try {
  const keys = z
    .record(z.string(), z.string().regex(/^[A-Za-z0-9+/]{43}=$/))
    .parse(JSON.parse(config.data.JIAN_MASTER_KEYS));

  box = new SecretBox({
    activeKeyId: config.data.JIAN_ACTIVE_KEY_ID,
    keys: Object.fromEntries(
      Object.entries(keys).map(([id, key]) => [id, Buffer.from(key, 'base64')]),
    ),
  });
} catch {
  console.error('Invalid encryption keyring. Configure JIAN_MASTER_KEYS and JIAN_ACTIVE_KEY_ID.');
  process.exit(1);
}

const gateway = await createGateway({
  store,
  box,
  token: config.data.JIAN_API_TOKEN,
  role: config.data.JIAN_ROLE,
  ...(config.data.JIAN_ROLE !== 'api'
    ? { executor: new BossExecutor(new PgBoss(config.data.DATABASE_URL)) }
    : {}),
  channels: 'all',
  allowPrivateOrigins: [
    ...config.data.JIAN_ALLOW_PRIVATE_ORIGINS.split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    ...(config.data.JIAN_CAVEMAN_ENABLED === 'true'
      ? [config.data.JIAN_CAVEMAN_PROXY_URL || 'http://127.0.0.1:8788']
      : []),
  ],
  trustedProxies: config.data.JIAN_TRUSTED_PROXIES.split(',')
    .map((value) => value.trim())
    .filter(Boolean),
  ...(config.data.JIAN_PUBLIC_URL ? { publicUrl: config.data.JIAN_PUBLIC_URL } : {}),
  ...(config.data.JIAN_TIME_ZONE ? { timeZone: config.data.JIAN_TIME_ZONE } : {}),
});

process.once('SIGINT', () => {
  void gateway.stop();
});

process.once('SIGTERM', () => {
  void gateway.stop();
});

try {
  const { url } = await gateway.start(
    config.data.JIAN_ROLE !== 'worker'
      ? { host: config.data.HOST, port: config.data.PORT }
      : undefined,
  );
  if (!url) console.info('Jian worker started');
} catch (error) {
  console.error(startupFailure(gateway.stage(), error));
  await gateway.stop().catch(() => {});
  process.exitCode = 1;
}
