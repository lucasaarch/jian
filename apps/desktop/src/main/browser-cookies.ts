import { execFile } from 'node:child_process';
import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Session } from 'electron';

/**
 * Bringing the owner's logins from their everyday browser. Only the owner starts this, from the
 * browser's menu: no agent can reach it, and the values never leave the main process or get logged.
 */
export type CookieSourceId = 'chrome' | 'brave' | 'edge' | 'arc' | 'safari';
export type CookieSource = { id: CookieSourceId; name: string };
export type ImportedCookie = {
  host: string;
  name: string;
  value: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  /** Seconds since the Unix epoch; absent for a cookie that lasts the session. */
  expires?: number;
  sameSite: 'unspecified' | 'no_restriction' | 'lax' | 'strict';
};

const SUPPORT = join(homedir(), 'Library', 'Application Support');
const CHROMIUM: Record<
  Exclude<CookieSourceId, 'safari'>,
  { name: string; dir: string; keychain: string }
> = {
  chrome: { name: 'Chrome', dir: 'Google/Chrome', keychain: 'Chrome Safe Storage' },
  brave: {
    name: 'Brave',
    dir: 'BraveSoftware/Brave-Browser',
    keychain: 'Brave Safe Storage',
  },
  edge: { name: 'Edge', dir: 'Microsoft Edge', keychain: 'Microsoft Edge Safe Storage' },
  arc: { name: 'Arc', dir: 'Arc/User Data', keychain: 'Arc Safe Storage' },
};
const SAFARI_FILES = [
  join(homedir(), 'Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies'),
  join(homedir(), 'Library/Cookies/Cookies.binarycookies'),
];

/** Seconds between 1601, where Chromium counts from, and the Unix epoch. */
const CHROMIUM_EPOCH = 11_644_473_600;
/** Seconds between 2001, where Safari counts from, and the Unix epoch. */
const SAFARI_EPOCH = 978_307_200;
const SAME_SITE = { 0: 'no_restriction', 1: 'lax', 2: 'strict' } as const;

/** The profile the owner last used, where their logins are, and the file that holds its cookies. */
async function chromiumCookieFile(dir: string): Promise<string | undefined> {
  const root = join(SUPPORT, dir);
  let profile = 'Default';
  try {
    const state = JSON.parse(await readFile(join(root, 'Local State'), 'utf8'));
    profile = state?.profile?.last_used || profile;
  } catch {
    // No readable state: the default profile is still where a single-profile browser keeps them.
  }
  return [join(root, profile, 'Network', 'Cookies'), join(root, profile, 'Cookies')].find(
    existsSync,
  );
}

/** Which browsers on this computer can be read. Only macOS so far. */
export async function cookieSources(): Promise<CookieSource[]> {
  if (process.platform !== 'darwin') return [];
  const found: CookieSource[] = [];
  for (const [id, browser] of Object.entries(CHROMIUM)) {
    if (await chromiumCookieFile(browser.dir))
      found.push({ id: id as CookieSourceId, name: browser.name });
  }
  if (SAFARI_FILES.some((file) => existsSync(file))) found.push({ id: 'safari', name: 'Safari' });
  return found;
}

/** The cookie store's key: the owner sees macOS ask before this answers. */
const keychainPassword = (service: string) =>
  new Promise<string>((resolve, reject) => {
    execFile('security', ['find-generic-password', '-w', '-s', service], (error, stdout) => {
      if (error) reject(new Error('The keychain did not give access to the browser cookies'));
      else resolve(stdout.trim());
    });
  });

const decrypt = (encrypted: Uint8Array, key: Buffer, version: number) => {
  const data = Buffer.from(encrypted);
  if (data.subarray(0, 3).toString() !== 'v10') return null;
  const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '));
  const plain = Buffer.concat([decipher.update(data.subarray(3)), decipher.final()]);
  // From schema 24 on, the value starts with the hash of the domain it was written for.
  return (version >= 24 ? plain.subarray(32) : plain).toString('utf8');
};

/** A copy is read, not the file: the browser may hold it open, and it must never be written. */
export async function readChromiumCookies(
  file: string,
  password: string,
  now = Date.now() / 1000,
): Promise<ImportedCookie[]> {
  const temporary = await mkdtemp(join(tmpdir(), 'jian-cookies-'));
  try {
    const copy = join(temporary, 'Cookies');
    await copyFile(file, copy);
    if (existsSync(`${file}-wal`)) await copyFile(`${file}-wal`, `${copy}-wal`);
    const database = new DatabaseSync(copy);
    try {
      const key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
      const version = Number(
        (
          database.prepare(`select value from meta where key = 'version'`).get() as
            | { value: string }
            | undefined
        )?.value ?? 0,
      );
      const query = database.prepare(
        'select host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite from cookies',
      );
      // Microseconds since 1601 are past what a JavaScript number can hold exactly.
      query.setReadBigInts(true);
      const rows = query.all() as Array<{
        host_key: string;
        name: string;
        value: string;
        encrypted_value: Uint8Array;
        path: string;
        expires_utc: bigint;
        is_secure: bigint;
        is_httponly: bigint;
        samesite: bigint;
      }>;
      const cookies: ImportedCookie[] = [];
      for (const row of rows) {
        const expires = row.expires_utc
          ? Number(row.expires_utc / 1_000_000n) - CHROMIUM_EPOCH
          : undefined;
        if (expires !== undefined && expires <= now) continue;
        let value: string | null = row.value;
        if (!value && row.encrypted_value.length) {
          try {
            value = decrypt(row.encrypted_value, key, version);
          } catch {
            value = null;
          }
        }
        if (value === null) continue;
        cookies.push({
          host: row.host_key,
          name: row.name,
          value,
          path: row.path,
          secure: Boolean(row.is_secure),
          httpOnly: Boolean(row.is_httponly),
          ...(expires !== undefined ? { expires } : {}),
          sameSite: SAME_SITE[Number(row.samesite) as keyof typeof SAME_SITE] ?? 'unspecified',
        });
      }
      return cookies;
    } finally {
      database.close();
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

/** Safari's own format: big-endian pages of little-endian cookies, its strings null-ended. */
export function parseSafariCookies(file: Buffer, now = Date.now() / 1000): ImportedCookie[] {
  if (file.subarray(0, 4).toString('latin1') !== 'cook')
    throw new Error('This is not a Safari cookie file');
  const pages = file.readUInt32BE(4);
  const cookies: ImportedCookie[] = [];
  let start = 8 + pages * 4;
  for (let page = 0; page < pages; page += 1) {
    const size = file.readUInt32BE(8 + page * 4);
    const data = file.subarray(start, start + size);
    start += size;
    const count = data.readUInt32LE(4);
    for (let index = 0; index < count; index += 1) {
      const at = data.readUInt32LE(8 + index * 4);
      const text = (field: number) => {
        const from = at + data.readUInt32LE(at + field);
        return data.toString('utf8', from, data.indexOf(0, from));
      };
      const flags = data.readUInt32LE(at + 8);
      const expires = data.readDoubleLE(at + 40) + SAFARI_EPOCH;
      if (expires <= now) continue;
      cookies.push({
        host: text(16),
        name: text(20),
        path: text(24),
        value: text(28),
        secure: Boolean(flags & 1),
        httpOnly: Boolean(flags & 4),
        expires,
        sameSite: 'unspecified',
      });
    }
  }
  return cookies;
}

/** Whether a cookie applies to a site, so one site can be brought without every other login. */
export function cookieBelongsTo(host: string, hostname: string) {
  const cookie = host.replace(/^\./, '').toLowerCase();
  const site = hostname.replace(/^www\./, '').toLowerCase();
  return cookie === site || cookie.endsWith(`.${site}`) || site.endsWith(`.${cookie}`);
}

async function read(source: CookieSourceId): Promise<ImportedCookie[]> {
  if (source === 'safari') {
    for (const file of SAFARI_FILES) {
      if (!existsSync(file)) continue;
      try {
        return parseSafariCookies(await readFile(file));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EPERM')
          throw new Error('Reading Safari needs Full Disk Access for Jian, in System Settings');
        throw error;
      }
    }
    throw new Error('No Safari cookies were found');
  }
  const browser = CHROMIUM[source];
  const file = browser && (await chromiumCookieFile(browser.dir));
  if (!browser || !file) throw new Error('No cookies were found for that browser');
  return readChromiumCookies(file, await keychainPassword(browser.keychain));
}

export async function importCookies(
  session: Session,
  source: CookieSourceId,
  /** Only this site's cookies; every site's when absent. */
  hostname?: string,
) {
  const cookies = (await read(source)).filter(
    (cookie) => !hostname || cookieBelongsTo(cookie.host, hostname),
  );
  let imported = 0;
  for (const cookie of cookies) {
    const host = cookie.host.replace(/^\./, '');
    try {
      await session.cookies.set({
        url: `${cookie.secure ? 'https' : 'http'}://${host}${cookie.path || '/'}`,
        name: cookie.name,
        value: cookie.value,
        path: cookie.path,
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite: cookie.sameSite,
        // A cookie without a leading dot belongs to that exact host, which no domain says.
        ...(cookie.host.startsWith('.') ? { domain: cookie.host } : {}),
        ...(cookie.expires !== undefined ? { expirationDate: cookie.expires } : {}),
      });
      imported += 1;
    } catch {
      // A cookie this browser refuses, such as an invalid prefix, is counted and not fatal.
    }
  }
  await session.cookies.flushStore();
  return { imported, skipped: cookies.length - imported };
}
