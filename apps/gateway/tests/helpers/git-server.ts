import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

/** Git as the tests run it themselves, untouched by the developer's own configuration. */
const plainGitEnv = {
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test Author',
  GIT_AUTHOR_EMAIL: 'author@example.test',
  GIT_COMMITTER_NAME: 'Test Author',
  GIT_COMMITTER_EMAIL: 'author@example.test',
};

export const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: plainGitEnv, encoding: 'utf8' }).trim();

/** A bare repository at `<root>/<owner>/<name>.git` with one commit on main. */
export function bareRepository(root: string, fullName: string) {
  const bare = join(root, `${fullName}.git`);
  const seed = join(root, '.seed', fullName);

  mkdirSync(bare, { recursive: true });
  mkdirSync(seed, { recursive: true });
  git(bare, 'init', '--bare', '-q', '-b', 'main');
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, 'commit', '-q', '--allow-empty', '-m', 'First');
  git(seed, 'push', '-q', bare, 'main');
  return bare;
}

/**
 * GitHub's git endpoint, over plain HTTP on loopback: `git http-backend` behind a check of the
 * Basic credential. `allowed(token, repository)` is GitHub's decision; whatever it refuses
 * gets the 401 GitHub answers. Every Authorization header that arrives is kept.
 */
export async function gitServer(
  root: string,
  allowed: (token: string, repository: string) => boolean,
): Promise<{ origin: string; headers: string[]; close(): Promise<void> }> {
  const headers: string[] = [];
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const authorization = request.headers.authorization ?? '';
    headers.push(authorization);
    const [scheme, encoded = ''] = authorization.split(' ');
    const [user, token = ''] = Buffer.from(encoded, 'base64').toString('utf8').split(':');
    const repository = /^\/([^/]+\/[^/]+?)\.git\//.exec(url.pathname)?.[1] ?? '';

    if (
      scheme?.toLowerCase() !== 'basic' ||
      user !== 'x-access-token' ||
      !allowed(token, repository)
    ) {
      response.writeHead(401, { 'www-authenticate': 'Basic realm="GitHub"' }).end();
      return;
    }

    const backend = spawn('git', ['http-backend'], {
      env: {
        ...plainGitEnv,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: '1',
        PATH_INFO: decodeURIComponent(url.pathname),
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: request.method ?? 'GET',
        CONTENT_TYPE: request.headers['content-type'] ?? '',
        HTTP_CONTENT_ENCODING: request.headers['content-encoding'] ?? '',
        // http-backend accepts a push only from a user the server authenticated.
        REMOTE_USER: 'x-access-token',
        REMOTE_ADDR: '127.0.0.1',
      },
    });
    const chunks: Buffer[] = [];
    backend.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.pipe(backend.stdin);
    backend.on('close', () => {
      const output = Buffer.concat(chunks);
      const split = output.indexOf('\r\n\r\n');
      const head = output.subarray(0, split).toString('utf8').split('\r\n');
      const fields: Record<string, string> = {};
      let status = 200;
      for (const line of head) {
        const [name = '', ...rest] = line.split(':');
        const value = rest.join(':').trim();
        if (name.toLowerCase() === 'status') status = Number.parseInt(value, 10);
        else fields[name] = value;
      }
      response.writeHead(status, fields).end(output.subarray(split + 4));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${port}`,
    headers,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
