// A throwaway copy of Jian on a Cubeship instance, to try a pull request or a branch end to end
// before it is released: `make preview-up PR=157`, `make preview-down PR=157`.
// The Preview workflow builds the images this deploys and runs the same script.
// Everything a preview owns is named after it, and nothing else on the instance is written to.
import { randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';

const USAGE = `usage: node scripts/preview.mjs <up|down|status|token> <pr-number|name> [--tag <tag>]

  up      Create or update the preview and print its address. Safe to run again.
  down    Delete the preview: its apps, its environment and its database, data included.
  status  Say what is there.
  token   Print the host token the preview's panel and a desktop app sign in with.

A number is a pull request: environment preview-157, images tagged pr-157.
Anything else is a name: environment preview-<name>, images tagged branch-<name>.
--tag deploys another tag of both images, such as sha-1a2b3c4.

Environment:
  CUBESHIP_URL       The instance, such as https://cubeship.example.com.  Required.
  CUBESHIP_API_KEY   An API key that may manage projects, apps, domains and databases.  Required.
  CUBESHIP_PROJECT   The project the preview is an environment of.  Default: jian.
  PREVIEW_API_TOKEN  The host token of a new preview, 32 characters or more.  Default: generated.
  OPENAI_API_KEY, ANTHROPIC_API_KEY, ANTHROPIC_API_TOKEN, GEMINI_API_TOKEN
                     Passed on to the preview's gateway when set; otherwise add a provider in
                     its panel.

The desktop app reaches a preview as any gateway on a server: Connect a gateway, with the
address \`up\` prints and the token \`token\` prints.`;

const stop = (message) => {
  console.error(message);
  process.exit(1);
};

const [command, id, ...rest] = process.argv.slice(2);
if (command === '--help' || command === '-h' || command === 'help') {
  console.log(USAGE);
  process.exit(0);
}
if (!['up', 'down', 'status', 'token'].includes(command) || !id) stop(USAGE);
if (rest.length && (rest.length !== 2 || rest[0] !== '--tag' || !rest[1])) stop(USAGE);

// A Cubeship name is lowercase letters, digits and dashes; a branch name is made into one.
const slug = id
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 40)
  .replace(/-+$/, '');
if (!slug) stop(USAGE);

const base = (process.env.CUBESHIP_URL ?? '').replace(/\/+$/, '');
const key = process.env.CUBESHIP_API_KEY ?? '';
if (!base || !key) stop('Set CUBESHIP_URL and CUBESHIP_API_KEY. See --help.');

const project = process.env.CUBESHIP_PROJECT || 'jian';
const environment = `preview-${slug}`;
// A database belongs to the instance, not to an environment, so its name carries the project too.
const database = `${project}-${environment}`;
const tag = rest[1] ?? (/^\d+$/.test(id) ? `pr-${id}` : `branch-${slug}`);
const GATEWAY_PORT = 4310;
const WEB_PORT = 3000;
const GIB = 1024 ** 3;
const PROVIDER_KEYS = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_API_TOKEN',
  'GEMINI_API_TOKEN',
];

const appPath = (name) => `/apps/${project}/${environment}/${name}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One call to the instance. A GET or DELETE of what is not there answers undefined. */
async function api(method, path, body) {
  const response = await fetch(`${base}/api${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  if (response.status === 404 && (method === 'GET' || method === 'DELETE')) return undefined;
  if (!response.ok) stop(`${method} ${path} answered ${response.status}: ${text.trim()}`);
  return response.headers.get('content-type')?.includes('json') && text ? JSON.parse(text) : {};
}

async function ensureApp(name, image) {
  const existing = await api('GET', appPath(name));
  if (existing) return existing;
  console.log(`Creating the app ${name}`);
  return api('POST', '/apps', { name, project, environment, source: 'external', image, tag });
}

/** Deploys the tag and waits for the new container to pass its health check. */
async function deploy(name) {
  console.log(`Deploying ${name}:${tag}`);
  const started = await api('POST', `${appPath(name)}/deploy`, { tag });
  for (let waited = 0; waited < 600; waited += 3) {
    const deployment = await api('GET', `${appPath(name)}/deployments/${started.id}`);
    if (deployment?.status === 'succeeded' || deployment?.status === 'skipped') return;
    if (deployment?.status !== 'pending') {
      stop(`The deploy of ${name} ${deployment?.status ?? 'vanished'}: ${deployment?.error ?? ''}`);
    }
    await sleep(3_000);
  }
  stop(`The deploy of ${name} did not finish in ten minutes.`);
}

/** The first request for a new name is also what has its certificate issued, so this waits. */
async function answers(url) {
  for (let waited = 0; waited < 180; waited += 5) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (response.ok) return true;
    } catch {
      // Not resolving, no certificate yet, or the proxy has not learned the name.
    }
    await sleep(5_000);
  }
  return false;
}

async function up() {
  const environments = await api('GET', `/projects/${project}/environments`);
  if (!environments) stop(`There is no project ${project} on ${base}. Create it first.`);
  if (!environments.some((item) => item.slug === environment)) {
    console.log(`Creating the environment ${project}/${environment}`);
    await api('POST', `/projects/${project}/environments`, { slug: environment });
  }

  if (!(await api('GET', `/datastores/${database}`))) {
    console.log(`Creating the database ${database}`);
    await api('POST', '/datastores', {
      name: database,
      description: `Preview ${id} of Jian. Deleted by make preview-down.`,
      engine: 'postgres',
      version: '17',
      database: 'jian',
    });
    await api('PATCH', `/datastores/${database}`, { limits: { cpu: 1, memory_bytes: GIB } });
  }

  const gateway = await ensureApp('gateway', 'ghcr.io/lucasaarch/jian-gateway');
  const web = await ensureApp('web', 'ghcr.io/lucasaarch/jian-web');
  const host = web.suggested_host;
  if (!host) stop(`${base} suggests no name for the preview: it has no domain of its own.`);
  const url = `https://${host}`;

  // A preview shares its machine with whatever else the instance runs, so it gets a ceiling.
  await api('PATCH', appPath('gateway'), { limits: { cpu: 2, memory_bytes: 2 * GIB } });
  await api('PATCH', appPath('web'), { limits: { cpu: 0.5, memory_bytes: GIB / 2 } });
  await api('PUT', `${appPath('gateway')}/networking`, {
    internal_ports: [GATEWAY_PORT],
    health_checks: [{ path: '/health', port: GATEWAY_PORT }],
  });
  await api('PUT', `${appPath('web')}/networking`, {
    internal_ports: [WEB_PORT],
    health_checks: [{ path: '/web/health', port: WEB_PORT }],
  });
  if (!web.domains.some((domain) => domain.host === host)) {
    await api('POST', `${appPath('web')}/domains`, { host, port: WEB_PORT });
  }

  // The attachment is what gives the gateway DATABASE_URL; it migrates on start.
  const store = await api('GET', `/datastores/${database}`);
  const reference = `${project}/${environment}/gateway`;
  if (!store.attachments.some((attachment) => attachment.app === reference)) {
    await api('POST', `/datastores/${database}/attachments`, { app: reference });
  }

  // The token and the key are made once: a new key could not open what the database already
  // holds, and a new token would sign out whoever is trying the preview.
  const { vars } = await api('GET', `${appPath('gateway')}/env`);
  const set = {
    JIAN_PUBLIC_URL: url,
    JIAN_ACTIVE_KEY_ID: 'v1',
    // Only the web app reaches the gateway, so what it forwards is believed from private
    // addresses alone.
    JIAN_TRUSTED_PROXIES: 'uniquelocal',
  };
  if (!vars.JIAN_API_TOKEN) {
    set.JIAN_API_TOKEN = process.env.PREVIEW_API_TOKEN || randomBytes(32).toString('hex');
  }
  if (!vars.JIAN_MASTER_KEYS) {
    set.JIAN_MASTER_KEYS = JSON.stringify({ v1: randomBytes(32).toString('base64') });
  }
  for (const name of PROVIDER_KEYS) {
    if (!process.env[name]) continue;
    set[name] = process.env[name];
    console.log(`Passing ${name} on from this environment`);
  }
  await api('PATCH', `${appPath('gateway')}/env`, { set });
  await api('PATCH', `${appPath('web')}/env`, {
    set: { JIAN_GATEWAY_URL: `http://${gateway.internal_host}:${GATEWAY_PORT}` },
  });

  for (let waited = 0; ; waited += 3) {
    const { status, error } = await api('GET', `/datastores/${database}`);
    if (status === 'running') break;
    if (status === 'failed' || waited > 300) stop(`The database is ${status}: ${error ?? ''}`);
    await sleep(3_000);
  }
  await deploy('gateway');
  await deploy('web');

  // Through the panel's address, as a browser and the desktop app reach both.
  if (!(await answers(`${url}/web/health`)) || !(await answers(`${url}/health`))) {
    stop(`Deployed, but ${url} does not answer yet. Try it again in a minute.`);
  }
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `url=${url}\n`);
  console.log(`\nPreview ${id} is at ${url}`);
  console.log(`Its host token: node scripts/preview.mjs token ${id}`);
}

async function down() {
  const store = await api('GET', `/datastores/${database}`);
  // Deleting a database deletes its data, so it must be this preview's and nobody else's.
  const others = store?.attachments.filter(
    (attachment) => !attachment.app.startsWith(`${project}/${environment}/`),
  );
  if (others?.length) {
    stop(`${database} also serves ${others.map((item) => item.app).join(', ')}: not deleting.`);
  }
  const gone = await api('DELETE', `/projects/${project}/environments/${environment}`);
  console.log(`${project}/${environment}: ${gone ? 'deleted, with its apps' : 'not there'}`);
  if (store) await api('DELETE', `/datastores/${database}`);
  console.log(`${database}: ${store ? 'deleted, with its data' : 'not there'}`);
}

async function status() {
  const environments = await api('GET', `/projects/${project}/environments`);
  if (!environments?.some((item) => item.slug === environment)) {
    console.log(`${project}/${environment} does not exist.`);
  }
  for (const name of ['gateway', 'web']) {
    const app = await api('GET', appPath(name));
    console.log(`${name}: ${app ? `${app.status}, ${app.image}:${app.tag}` : 'not there'}`);
    for (const domain of app?.domains ?? []) console.log(`  https://${domain.host}`);
  }
  const store = await api('GET', `/datastores/${database}`);
  console.log(`${database}: ${store ? store.status : 'not there'}`);
}

async function token() {
  const env = await api('GET', `${appPath('gateway')}/env`);
  if (!env?.vars.JIAN_API_TOKEN) stop(`Preview ${id} has no gateway yet. Run up first.`);
  console.log(env.vars.JIAN_API_TOKEN);
}

await { up, down, status, token }[command]();
