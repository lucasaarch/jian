/**
 * A Jian Remote worker, for any host to run: the CLI's service, the native app. What a host
 * keeps to itself — where it installs, how it starts with the machine — stays with it.
 */
export { helpersRoot, useHelpersRoot } from './computer/helpers.ts';
export * from './log.ts';
export * from './result.ts';
export * from './shell.ts';
export * from './state.ts';
export * from './task.ts';
export * from './version.ts';
export * from './worker.ts';
