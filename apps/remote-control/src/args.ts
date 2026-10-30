export const args = process.argv.slice(2);
export const option = (name: string): string | undefined => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};

/**
 * Parse argv for the top-level command and version flags (`version`, `--version`, `-V`).
 * Version flags win over a subcommand so `jian-remote --version update` still prints the version.
 */
export function parseCliInvocation(argv: readonly string[] = args): {
  command: string | undefined;
  versionRequested: boolean;
} {
  const list = argv;
  if (list.includes('--version') || list.includes('-V') || list[0] === 'version') {
    return { command: 'version', versionRequested: true };
  }
  const command = list[0] && !list[0].startsWith('-') ? list[0] : undefined;
  return { command, versionRequested: false };
}
