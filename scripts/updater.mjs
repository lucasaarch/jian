// jian-updater: the optional compose service that updates Jian when the gateway asks. It holds
// the Docker socket, so it does one thing only: given a release, pull the gateway and web images
// of that tag and recreate those two services. PostgreSQL and the updater are never touched.
// Plain Node with no dependencies, so it runs from the checkout in the stock docker:cli image.
import { execFile } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';

const RELEASE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SERVICES = ['gateway', 'web'];
/** A request body past this is not a version. */
const MAX_BODY = 1024;

/** `.env` with JIAN_VERSION set to `version`, so a later `make up` keeps the same release. */
export function withVersion(env, version) {
  const line = `JIAN_VERSION=${version}`;
  if (/^JIAN_VERSION=.*$/m.test(env)) return env.replace(/^JIAN_VERSION=.*$/m, line);
  return `${env}${env && !env.endsWith('\n') ? '\n' : ''}${line}\n`;
}

// Hashed first, so the comparison takes as long whatever length was sent.
const same = (a, b) =>
  timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());

const docker = (cwd) => (args, env) =>
  new Promise((resolve, reject) => {
    execFile('docker', args, { cwd, env, maxBuffer: 16 * 1024 * 1024 }, (error, _out, err) => {
      if (error) reject(new Error(`docker ${args.join(' ')} failed: ${String(err).slice(-500)}`));
      else resolve();
    });
  });

/**
 * The updater's HTTP server. `run(args, env)` runs one docker command; `envFile` is the
 * project's `.env`. One update at a time: it answers 202 at once and works behind it, as the
 * gateway that asked is among what it restarts.
 */
export function createUpdater({ token, run, envFile, log = console.log }) {
  if (!token || token.length < 32) {
    throw new Error('JIAN_UPDATER_TOKEN must be set to 32 characters or more: run make setup');
  }
  let running = false;

  async function update(version) {
    running = true;
    try {
      const env = await readFile(envFile, 'utf8').catch((error) =>
        error.code === 'ENOENT' ? '' : Promise.reject(error),
      );
      await writeFile(envFile, withVersion(env, version));
      const environment = { ...process.env, JIAN_VERSION: version };
      log(`jian-updater: pulling ${version}`);
      await run(['compose', 'pull', ...SERVICES], environment);
      await run(['compose', 'up', '-d', '--no-deps', ...SERVICES], environment);
      log(`jian-updater: ${version} is up`);
    } catch (error) {
      log(`jian-updater: update to ${version} failed: ${error.message}`);
    } finally {
      running = false;
    }
  }

  return createServer((request, response) => {
    const send = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (!same(request.headers.authorization ?? '', `Bearer ${token}`)) {
      return send(401, { error: 'Unauthorized' });
    }
    if (request.method !== 'POST' || request.url !== '/update') {
      return send(404, { error: 'Not found' });
    }
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY) request.destroy();
    });
    request.on('end', () => {
      let version;
      try {
        version = JSON.parse(body).version;
      } catch {}
      if (typeof version !== 'string' || !RELEASE.test(version)) {
        return send(400, { error: 'A release version such as 1.2.3 is required' });
      }
      if (running) return send(409, { error: 'An update is already running' });
      void update(version);
      send(202, { version });
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const project = process.env.JIAN_PROJECT_DIR ?? process.cwd();
  const server = createUpdater({
    token: process.env.JIAN_UPDATER_TOKEN,
    run: docker(project),
    envFile: `${project}/.env`,
  });
  server.listen(Number(process.env.PORT ?? 8080), '0.0.0.0', () =>
    console.log('jian-updater: listening'),
  );
}
