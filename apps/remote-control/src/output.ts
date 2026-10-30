export const ANSI = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  red: '\u001b[31m',
};

/** Color when stdout is a TTY, unless NO_COLOR; FORCE_COLOR=1 enables even when piped. */
export function shouldColorize(
  options: { isTTY?: boolean; noColor?: string; forceColor?: string } = {},
): boolean {
  // Use `in` so tests can pass forceColor: undefined without falling back to the process env.
  const isTTY = 'isTTY' in options ? options.isTTY : process.stdout.isTTY;
  const noColor = 'noColor' in options ? options.noColor : process.env.NO_COLOR;
  const forceColor = 'forceColor' in options ? options.forceColor : process.env.FORCE_COLOR;
  if (noColor !== undefined && noColor !== '') return false;
  if (forceColor !== undefined && forceColor !== '' && forceColor !== '0') return true;
  return Boolean(isTTY);
}

/** One aligned line of a success block: a short label and what it names. */
export type Fact = [label: string, value: string];

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

export function paint(text: string, code: string, color: boolean): string {
  return color ? `${code}${text}${ANSI.reset}` : text;
}

/**
 * Tasteful success block for install/configure/update — headline plus aligned facts.
 * Keep facts short; avoid rainbow spam.
 */
export function formatSuccessBlock({
  headline,
  facts = [],
  color = shouldColorize(),
  mark = paint('✓', ANSI.green, color),
}: {
  headline: string;
  facts?: Fact[];
  color?: boolean;
  mark?: string;
}): string {
  const title = paint(headline, ANSI.bold, color);
  const lines = [`${mark} ${title}`];
  const width = Math.min(12, Math.max(0, ...facts.map(([label]) => String(label).length)));
  for (const [label, value] of facts) {
    const key = paint(String(label).padEnd(width), ANSI.dim, color);
    lines.push(`  ${key}  ${value}`);
  }
  return `${lines.join('\n')}\n`;
}

export function printSuccess(headline: string, facts: Fact[]): void {
  process.stdout.write(formatSuccessBlock({ headline, facts, color: shouldColorize() }));
}

export function printInfo(message: string): void {
  const color = shouldColorize();
  const prefix = paint('·', ANSI.dim, color);
  console.log(`${prefix} ${message}`);
}
