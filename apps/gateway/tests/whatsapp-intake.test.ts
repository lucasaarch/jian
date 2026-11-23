import { randomBytes } from 'node:crypto';
import { createServer, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PassThrough, Readable } from 'node:stream';
import { downloadEncryptedContent } from 'baileys';
import { expect, it } from 'vitest';
import { DeviceIntake } from '../src/channels/whatsapp/intake.js';
import { readDownload } from '../src/channels/whatsapp/media.js';

const later = () => new Promise((resolve) => setTimeout(resolve, 1));
const keys = { cipherKey: randomBytes(32), iv: randomBytes(16) };

/** A media host on this machine, for Baileys' real download code to fail against. */
async function mediaHost(answer: RequestListener) {
  const server = createServer(answer);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/media`,
    close: () => {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

// Unpatched, this failure is an uncaught error: in production it ends the gateway.
it('fails the one download when its connection drops halfway', async () => {
  const host = await mediaHost((_request, response) => {
    response.writeHead(200, { 'content-length': '4096' });
    response.write(Buffer.alloc(32));
    setTimeout(() => response.destroy(), 10);
  });

  try {
    await expect(
      readDownload((signal) => downloadEncryptedContent(host.url, keys, { options: { signal } })),
    ).rejects.toThrow();
  } finally {
    await host.close();
  }
});

it('hangs up on a media host that never answers once the limit passes', async () => {
  let hungUp: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    hungUp = resolve;
  });
  const host = await mediaHost((_request, response) => {
    response.on('close', hungUp);
  });

  try {
    await expect(
      readDownload(
        (signal) => downloadEncryptedContent(host.url, keys, { options: { signal } }),
        50,
      ),
    ).rejects.toThrow('took too long');
    await closed;
  } finally {
    await host.close();
  }
});

it('gives up on a download whose connection stalls, and lets go of its stream', async () => {
  const stalled = new PassThrough();
  stalled.write('partial');

  await expect(readDownload(async () => stalled, 20)).rejects.toThrow('took too long');
  expect(stalled.destroyed).toBe(true);
});

it('gives up on a download that never starts, and closes it if it starts late', async () => {
  const late = new PassThrough();
  let start: (stream: Readable) => void = () => {};
  const opening = new Promise<Readable>((resolve) => {
    start = resolve;
  });

  await expect(readDownload(() => opening, 20)).rejects.toThrow('took too long');
  start(late);
  await later();
  expect(late.destroyed).toBe(true);
});

it('reads a download that arrives whole', async () => {
  const data = await readDownload(async () => Readable.from([Buffer.from('ab'), Buffer.from('c')]));

  expect(data.toString()).toBe('abc');
});

it('holds few attachments at once and keeps each chat in the order it arrived', async () => {
  const intake = new DeviceIntake(2);
  const done: string[] = [];
  let busy = 0;
  let most = 0;
  const attachment = (name: string) => async () => {
    busy += 1;
    most = Math.max(most, busy);
    await later();
    busy -= 1;
    done.push(name);
  };
  const work: Promise<void>[] = [];

  for (let chat = 0; chat < 6; chat++) {
    work.push(intake.take(`chat-${chat}`, true, attachment(`${chat}:photo`)));
    work.push(
      intake.take(`chat-${chat}`, false, async () => {
        done.push(`${chat}:text`);
      }),
    );
  }
  await Promise.all(work);

  expect(most).toBe(2);
  for (let chat = 0; chat < 6; chat++) {
    expect(done.indexOf(`${chat}:photo`)).toBeLessThan(done.indexOf(`${chat}:text`));
  }
});

it('goes on with a chat after one of its messages failed, and reports that failure', async () => {
  const intake = new DeviceIntake(1);
  const done: string[] = [];
  const failed = intake.take('chat', true, async () => {
    throw new Error('download failed');
  });
  const next = intake.take('chat', true, async () => {
    done.push('next');
  });

  await expect(failed).rejects.toThrow('download failed');
  await next;
  expect(done).toEqual(['next']);
});
