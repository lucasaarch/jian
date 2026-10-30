import { statSync } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { LOG_LEVELS, type LogLevel, logLineLevel } from '@jian/remote-core';
import { args, option } from './args.ts';
import { printInfo } from './output.ts';
import { logPath } from './paths.ts';
/**
 * The worker's log: the last lines (`--lines N`, 100 by default), from a level up
 * (`--level warn`), and with `--follow` the new ones as they are written.
 */
export async function logs(): Promise<void> {
  const count = Math.max(1, Number(option('--lines') ?? option('-n') ?? 100) || 100);
  const level = option('--level');
  if (level && !isLogLevel(level)) {
    throw new Error(`--level takes one of ${LOG_LEVELS.join(', ')}`);
  }
  const floor = level && isLogLevel(level) ? LOG_LEVELS.indexOf(level) : 0;
  const shown = (line: string) => {
    if (!line) return false;
    const at = logLineLevel(line);
    // A line the format did not write (a crash the service caught) always shows.
    return at === undefined || LOG_LEVELS.indexOf(at) >= floor;
  };
  let text = '';
  try {
    text = await readFile(logPath, 'utf8');
  } catch {
    printInfo(`No log yet at ${logPath}. It starts when the worker runs.`);
    if (!args.includes('--follow') && !args.includes('-f')) return;
  }
  const lines = text.split('\n').filter(shown);
  for (const line of lines.slice(-count)) process.stdout.write(`${line}\n`);
  if (!args.includes('--follow') && !args.includes('-f')) return;

  // Follow: read what was added since, every half second; a rotation starts the file over.
  let offset = Buffer.byteLength(text);
  let rest = '';
  while (true) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
    let size: number;
    try {
      size = statSync(logPath).size;
    } catch {
      continue;
    }
    if (size < offset) offset = 0;
    if (size === offset) continue;
    const handle = await open(logPath, 'r');
    try {
      const chunk = Buffer.alloc(size - offset);
      await handle.read(chunk, 0, chunk.length, offset);
      offset = size;
      const parts = `${rest}${chunk.toString('utf8')}`.split('\n');
      rest = parts.pop() ?? '';
      for (const line of parts.filter(shown)) process.stdout.write(`${line}\n`);
    } finally {
      await handle.close();
    }
  }
}

const isLogLevel = (value: string): value is LogLevel =>
  (LOG_LEVELS as readonly string[]).includes(value);
