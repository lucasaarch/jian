import { createCipheriv, createHash, pbkdf2Sync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { cookieBelongsTo, parseSafariCookies, readChromiumCookies } from './browser-cookies';

const NOW = 1_800_000_000;
const CHROMIUM_EPOCH = 11_644_473_600;
const inMicroseconds = (unix: number) => BigInt(unix + CHROMIUM_EPOCH) * 1_000_000n;
const PASSWORD = 'synthetic-keychain-secret';
const places: string[] = [];
afterEach(() => {
  for (const place of places.splice(0)) rmSync(place, { recursive: true, force: true });
});

const seal = (value: string, host: string, version: number, password = PASSWORD) => {
  const key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
  const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '));
  const plain = Buffer.concat([
    ...(version >= 24 ? [createHash('sha256').update(host).digest()] : []),
    Buffer.from(value),
  ]);
  return Buffer.concat([Buffer.from('v10'), cipher.update(plain), cipher.final()]);
};

function chromium(version: number) {
  const place = mkdtempSync(join(tmpdir(), 'jian-cookie-test-'));
  places.push(place);
  const file = join(place, 'Cookies');
  const database = new DatabaseSync(file);
  database.exec(`create table meta (key text, value text);
    create table cookies (host_key text, name text, value text, encrypted_value blob, path text,
      expires_utc integer, is_secure integer, is_httponly integer, samesite integer);`);
  database.prepare('insert into meta values (?, ?)').run('version', String(version));
  const insert = database.prepare('insert into cookies values (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const later = inMicroseconds(NOW + 3600);
  insert.run(
    '.atlas.test',
    'session',
    '',
    seal('nova', '.atlas.test', version),
    '/',
    later,
    1,
    1,
    1,
  );
  insert.run('atlas.test', 'plain', 'visible', new Uint8Array(), '/app', later, 0, 0, -1);
  insert.run('atlas.test', 'lasting', 'tab', new Uint8Array(), '/', 0, 0, 0, 2);
  insert.run(
    'atlas.test',
    'old',
    '',
    seal('x', 'atlas.test', version),
    '/',
    inMicroseconds(NOW - 1),
    0,
    0,
    0,
  );
  insert.run('atlas.test', 'bound', '', Buffer.from('v20opaque'), '/', later, 0, 0, 0);
  database.close();
  return file;
}

describe('reading a Chromium cookie store', () => {
  it.each([[23], [24]])('opens schema %i values with the keychain password', async (version) => {
    const file = chromium(version);
    const before = readFileSync(file);

    const cookies = await readChromiumCookies(file, PASSWORD, NOW);

    expect(cookies.find((cookie) => cookie.name === 'session')).toMatchObject({
      host: '.atlas.test',
      value: 'nova',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
    });
    expect(cookies.find((cookie) => cookie.name === 'plain')).toMatchObject({
      value: 'visible',
      path: '/app',
      sameSite: 'unspecified',
    });
    // The browser's own file is never written, whatever it holds.
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it('keeps a session cookie, and leaves out the expired and what it cannot open', async () => {
    const names = (await readChromiumCookies(chromium(24), PASSWORD, NOW)).map(({ name }) => name);

    expect(names).toContain('lasting');
    expect(names).not.toContain('old');
    expect(names).not.toContain('bound');
  });

  it('brings no value under a wrong password', async () => {
    const cookies = await readChromiumCookies(chromium(24), 'not-the-password', NOW);

    expect(cookies.map(({ name }) => name)).not.toContain('session');
  });
});

/** One page of Safari's format, its numbers written the way the browser writes them. */
function safariFile() {
  const strings = ['.atlas.test\0', 'session\0', '/\0', 'nova\0'].map((text) => Buffer.from(text));
  const head = 56;
  const body = Buffer.alloc(head);
  body.writeUInt32LE(head + Buffer.concat(strings).length, 0);
  body.writeUInt32LE(1 | 4, 8);
  let at = head;
  for (const [index, text] of strings.entries()) {
    body.writeUInt32LE(at, 16 + index * 4);
    at += text.length;
  }
  body.writeDoubleLE(NOW + 3600 - 978_307_200, 40);
  const cookie = Buffer.concat([body, ...strings]);
  const pageHead = Buffer.alloc(16);
  pageHead.writeUInt32BE(0x100, 0);
  pageHead.writeUInt32LE(1, 4);
  pageHead.writeUInt32LE(16, 8);
  const page = Buffer.concat([pageHead, cookie]);
  const fileHead = Buffer.alloc(12);
  fileHead.write('cook', 0, 'latin1');
  fileHead.writeUInt32BE(1, 4);
  fileHead.writeUInt32BE(page.length, 8);
  return Buffer.concat([fileHead, page]);
}

describe('reading Safari cookies', () => {
  it('parses its binary format', () => {
    expect(parseSafariCookies(safariFile(), NOW)).toEqual([
      {
        host: '.atlas.test',
        name: 'session',
        path: '/',
        value: 'nova',
        secure: true,
        httpOnly: true,
        expires: NOW + 3600,
        sameSite: 'unspecified',
      },
    ]);
  });

  it('leaves out what has expired, and refuses another file', () => {
    expect(parseSafariCookies(safariFile(), NOW + 7200)).toEqual([]);
    expect(() => parseSafariCookies(Buffer.from('not cookies'))).toThrow('Safari');
  });
});

it('matches a site and its subdomains, never a lookalike', () => {
  expect(cookieBelongsTo('.claude.ai', 'claude.ai')).toBe(true);
  expect(cookieBelongsTo('app.claude.ai', 'www.claude.ai')).toBe(true);
  expect(cookieBelongsTo('.claude.ai', 'app.claude.ai')).toBe(true);
  expect(cookieBelongsTo('notclaude.ai', 'claude.ai')).toBe(false);
  expect(cookieBelongsTo('claude.ai.example.test', 'claude.ai')).toBe(false);
});
