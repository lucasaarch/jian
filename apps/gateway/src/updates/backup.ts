/** The Upgrading section of a release note, up to the next heading of its level or above. */
function upgrading(body: string): string {
  const lines: string[] = [];
  let level = 0;

  for (const line of body.split(/\r?\n/)) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const depth = heading[1]?.length ?? 0;
      if (level && depth <= level) break;
      if (!level && /^upgrading\b/i.test(heading[2]?.trim() ?? '')) {
        level = depth;
        continue;
      }
    }
    if (level) lines.push(line);
  }

  return lines.join('\n');
}

/**
 * Whether a release asks for a backup before it is installed: its Upgrading section says to back
 * up, or that a migration drops or deletes something. Read from the words alone, so it errs
 * towards asking: a needless confirmation costs a click, a missed one can cost data.
 */
export function needsBackup(body: string): boolean {
  return /\bback(?:\s|-)?up\b|\bdrops?\b|\bdelete[sd]?\b|\bnot kept\b/i.test(upgrading(body));
}
