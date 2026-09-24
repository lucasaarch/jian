import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { SecretBox } from '../src/security/crypto.js';
import { createSafeFetch, isPublicAddress, validateEndpoint } from '../src/security/outbound.js';
import { hashToken, issueToken, verifyToken } from '../src/security/tokens.js';

describe('secret encryption', () => {
  const keys = { first: randomBytes(32), second: randomBytes(32) };

  it('binds ciphertext to associated data and detects tampering', () => {
    const box = new SecretBox({ activeKeyId: 'first', keys });
    const envelope = box.encrypt('test credential', 'provider:profile-a:id-1');

    expect(box.decrypt(envelope, 'provider:profile-a:id-1')).toBe('test credential');
    expect(() => box.decrypt(envelope, 'provider:profile-b:id-1')).toThrow();

    expect(() =>
      box.decrypt(
        { ...envelope, ciphertext: Buffer.from('changed').toString('base64') },
        'provider:profile-a:id-1',
      ),
    ).toThrow();
  });

  it('rotates to the active key while retaining old-key reads', () => {
    const oldBox = new SecretBox({ activeKeyId: 'first', keys: { first: keys.first } });
    const oldEnvelope = oldBox.encrypt('dummy', 'mcp:profile-a:id-2');
    const newBox = new SecretBox({ activeKeyId: 'second', keys });
    const rotated = newBox.rotate(oldEnvelope, 'mcp:profile-a:id-2');

    expect(rotated.keyId).toBe('second');
    expect(newBox.decrypt(oldEnvelope, 'mcp:profile-a:id-2')).toBe('dummy');
    expect(newBox.decrypt(rotated, 'mcp:profile-a:id-2')).toBe('dummy');
    expect(() => oldBox.decrypt(rotated, 'mcp:profile-a:id-2')).toThrow();
  });

  it('rejects invalid keys, envelopes and unbound input without exposing plaintext', () => {
    expect(() => new SecretBox({ activeKeyId: 'bad', keys: { bad: randomBytes(16) } })).toThrow();

    const box = new SecretBox({ activeKeyId: 'first', keys });

    expect(() => box.encrypt('sensitive', '')).toThrow();

    const envelope = box.encrypt('sensitive', 'provider:profile-a:id-1');

    try {
      box.decrypt({ ...envelope, tag: 'bad!' }, 'provider:profile-a:id-1');

      throw new Error('decryption unexpectedly succeeded');
    } catch (error) {
      expect(String(error)).not.toContain('sensitive');
    }
  });
});

describe('access tokens', () => {
  it('issues independent high-entropy tokens and verifies only their hashes', () => {
    const first = issueToken();
    const second = issueToken();

    expect(first.token).not.toBe(second.token);
    expect(first.hash).toBe(hashToken(first.token));
    expect(first.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(first.prefix).toBe(first.token.slice(0, 12));
    expect(verifyToken(first.token, first.hash)).toBe(true);
    expect(verifyToken(second.token, first.hash)).toBe(false);
    expect(verifyToken(first.token, 'malformed')).toBe(false);
  });

  it('rejects empty or excessive token input', () => {
    expect(() => hashToken('')).toThrow();
    expect(() => hashToken('x'.repeat(4096))).toThrow();
    expect(verifyToken('x'.repeat(4096), 'a'.repeat(64))).toBe(false);
  });
});

describe('outbound policy', () => {
  const clients: ReturnType<typeof createSafeFetch>[] = [];

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
  });

  it.each([
    '127.0.0.1',
    '2130706433',
    '0177.0.0.1',
    '10.1.2.3',
    '169.254.169.254',
    '100.100.100.200',
    '::1',
    '::ffff:127.0.0.1',
    '2001:db8::1',
  ])('rejects nonpublic address %s', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])(
    'accepts public address %s',
    (address) => {
      expect(isPublicAddress(address)).toBe(true);
    },
  );

  it('enforces HTTPS and blocks URL credentials, fragments and metadata even if configured', () => {
    expect(() => validateEndpoint('http://example.com')).toThrow();
    expect(() => validateEndpoint('https://user:pass@example.com')).toThrow();
    expect(() => validateEndpoint('https://@example.com')).toThrow();
    expect(() => validateEndpoint('https://example.com/path#fragment')).toThrow();
    expect(() => validateEndpoint('https://example.com/path#')).toThrow();
    expect(() => validateEndpoint('http://169.254.169.254/', ['http://169.254.169.254'])).toThrow();

    expect(() =>
      validateEndpoint('http://metadata.google.internal/', ['http://metadata.google.internal']),
    ).toThrow();

    expect(() =>
      validateEndpoint('http://metadata.tencentyun.com/', ['http://metadata.tencentyun.com']),
    ).toThrow();

    expect(() => validateEndpoint('http://127.0.0.1/', ['http://localhost'])).toThrow();
    expect(() => validateEndpoint('http://127.0.0.1/', ['http://127.0.0.1'])).not.toThrow();
    expect(() => validateEndpoint('https://[::1]/')).toThrow();
    expect(() => validateEndpoint('https://[::ffff:127.0.0.1]/')).toThrow();
    expect(() => validateEndpoint('http://[fe80::1]/', ['http://[fe80::1]'])).toThrow();
    expect(() => validateEndpoint('http://[fd00:ec2::254]/', ['http://[fd00:ec2::254]'])).toThrow();

    expect(() =>
      validateEndpoint('http://[::ffff:169.254.1.1]/', ['http://[::ffff:169.254.1.1]']),
    ).toThrow();

    expect(() => validateEndpoint('http://2130706433/', ['http://127.0.0.1'])).toThrow();
    expect(() => validateEndpoint('http://0177.0.0.1/', ['http://127.0.0.1'])).toThrow();
  });

  it('sends a file upload as multipart, as a transcription server requires', async () => {
    const server = createServer((request, response) => {
      let body = '';

      request.on('data', (chunk) => {
        body += chunk;
      });
      request.on('end', () => {
        response.end(
          JSON.stringify({
            type: request.headers['content-type'],
            file: body.includes('filename="voice.ogg"') && body.includes('ogg-bytes'),
          }),
        );
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const client = createSafeFetch({ allowPrivateOrigins: [origin] });
    const form = new FormData();

    form.set('model', 'whisper-large-v3');
    form.set('file', new Blob(['ogg-bytes'], { type: 'audio/ogg' }), 'voice.ogg');
    clients.push(client);

    try {
      const answer = await (
        await client.fetch(`${origin}/v1/audio/transcriptions`, { method: 'POST', body: form })
      ).json();

      expect(answer.type).toMatch(/^multipart\/form-data; boundary=/);
      expect(answer.file).toBe(true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('rejects any private DNS answer, including a mixed answer set', async () => {
    const client = createSafeFetch({ lookup: async () => ['8.8.8.8', '127.0.0.1'] });

    clients.push(client);
    await expect(client.fetch('https://example.com/')).rejects.toThrow();
  });

  it('allows an exact configured local origin and refuses redirects', async () => {
    const server = createServer((request, response) => {
      if (request.url === '/redirect') {
        response.writeHead(302, { location: '/ok' }).end();

        return;
      }

      if (request.url?.startsWith('/disconnect')) {
        request.socket.destroy();

        return;
      }

      if (request.url === '/echo') {
        let body = '';

        request.setEncoding('utf8');

        request.on('data', (chunk: string) => {
          body += chunk;
        });

        request.on('end', () => response.writeHead(200).end(`${request.method}:${body}`));

        return;
      }

      response.writeHead(200).end('local-ok');
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const client = createSafeFetch({ allowPrivateOrigins: [origin] });

    clients.push(client);

    try {
      expect(await (await client.fetch(`${origin}/ok`)).text()).toBe('local-ok');

      expect(
        await (
          await client.fetch(new Request(`${origin}/echo`, { method: 'POST', body: 'dummy' }))
        ).text(),
      ).toBe('POST:dummy');

      await expect(client.fetch(`${origin}/redirect`)).rejects.toThrow();

      await expect(client.fetch(`${origin}/disconnect?secret=dummy-credential`)).rejects.toThrow(
        'Outbound request failed',
      );

      await expect(
        client.fetch(`http://localhost:${(server.address() as AddressInfo).port}/ok`),
      ).rejects.toThrow();
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it('pins a permitted hostname to its validated DNS answer', async () => {
    const server = createServer((_request, response) => response.writeHead(200).end('dns-ok'));

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

    const origin = `http://localhost:${(server.address() as AddressInfo).port}`;

    const client = createSafeFetch({
      allowPrivateOrigins: [origin],
      lookup: async () => ['127.0.0.1'],
    });

    clients.push(client);

    try {
      expect(await (await client.fetch(`${origin}/`)).text()).toBe('dns-ok');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
