import { randomBytes } from 'node:crypto';
import { appendFile, chmod, readFile, writeFile } from 'node:fs/promises';

const masterKeys = JSON.stringify({ v1: randomBytes(32).toString('base64') });
const password = randomBytes(24).toString('hex');
const updaterToken = randomBytes(32).toString('hex');
const contents = `JIAN_API_TOKEN=${randomBytes(32).toString('hex')}
JIAN_ACTIVE_KEY_ID=v1
JIAN_MASTER_KEYS='${masterKeys}'
POSTGRES_PASSWORD=${password}
JIAN_UPDATER_TOKEN=${updaterToken}
DATABASE_URL=postgres://jian:${password}@localhost:5432/jian
HOST=127.0.0.1
PORT=4310
JIAN_ROLE=all
JIAN_TIME_ZONE=
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
ANTHROPIC_API_TOKEN=
GEMINI_API_TOKEN=
`;
try {
  await writeFile(new URL('../.env', import.meta.url), contents, { mode: 0o600, flag: 'wx' });
  console.log('.env created with local credentials. Set the provider key before running agents.');
} catch (error) {
  if (error.code === 'EEXIST') {
    const path = new URL('../.env', import.meta.url);
    const existing = await readFile(path, 'utf8');
    const has = (name) => new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`, 'm').test(existing);
    const added = [];
    if (!has('JIAN_MASTER_KEYS')) {
      await appendFile(path, `\nJIAN_ACTIVE_KEY_ID=v1\nJIAN_MASTER_KEYS='${masterKeys}'\n`);
      added.push('Vault');
    }
    // For the optional compose updater; nothing reads it until that is switched on.
    if (!has('JIAN_UPDATER_TOKEN')) {
      await appendFile(path, `\nJIAN_UPDATER_TOKEN=${updaterToken}\n`);
      added.push('Updater token');
    }
    if (added.length) {
      await chmod(path, 0o600);
      console.log(`${added.join(' and ')} added to .env; existing settings kept.`);
    } else console.log('.env already exists; nothing changed.');
  } else throw error;
}
