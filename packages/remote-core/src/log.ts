import { appendFileSync, existsSync, renameSync, statSync } from 'node:fs';

/** Levels in order; `logs --level` shows one and those above it. */
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
/** The facts of a log line; an empty one is left out. */
export type LogFields = Record<string, unknown>;
export type Logger = Record<LogLevel, (message: string, fields?: LogFields) => void>;
/** A log past this size moves aside to worker.log.1, so a busy worker never fills the disk. */
const LOG_MAX_BYTES = 5 * 1024 * 1024;

/** A value as a log reads it: bare when it can be, quoted when it holds spaces or quotes. */
function logValue(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text !== undefined && /^[^\s"=]+$/.test(text) ? text : JSON.stringify(text ?? '');
}

/**
 * One line of the worker's log: the time in UTC, the level, what happened, then its facts as
 * key=value. One line each, so `logs` can cut, filter and follow it without parsing.
 */
export function formatLogLine(
  level: LogLevel,
  message: string,
  fields: LogFields = {},
  at = new Date(),
): string {
  const facts = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${logValue(value)}`);
  return `${at.toISOString()} ${level.toUpperCase().padEnd(5)} ${message}${facts.length ? ` ${facts.join(' ')}` : ''}\n`;
}

/** The level of a log line, or undefined for a line this format did not write. */
export function logLineLevel(line: string): LogLevel | undefined {
  const match = /^\S+ (DEBUG|INFO|WARN|ERROR)\b/.exec(line);
  return match?.[1] ? (match[1].toLowerCase() as LogLevel) : undefined;
}

/**
 * A worker's log, written to `path` whatever host runs it: the CLI's service, the native app.
 * In a terminal (`run` by hand) the lines show there too; a service reads the file instead.
 */
export function createLogger({
  path,
  echo = Boolean(process.stdout.isTTY),
}: {
  path: string;
  echo?: boolean;
}): Logger {
  const write = (level: LogLevel, message: string, fields?: LogFields) => {
    const line = formatLogLine(level, message, fields);
    try {
      if (existsSync(path) && statSync(path).size > LOG_MAX_BYTES) renameSync(path, `${path}.1`);
      appendFileSync(path, line, { mode: 0o600 });
    } catch {
      // A log that cannot be written must never stop the worker; the terminal still shows it.
    }
    if (echo) (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line);
  };

  return {
    debug: (message, fields) => write('debug', message, fields),
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
  };
}
