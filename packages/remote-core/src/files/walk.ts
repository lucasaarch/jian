/** What the fallback search is asked, all plain data: it crosses into a worker thread. */
export type WalkJob = {
  target: string;
  pattern: string;
  ignoreCase: boolean;
  glob: string | undefined;
  contextLines: number;
  output: 'content' | 'files' | 'count';
  /** Stop after this many output lines. */
  limit: number;
  /** Stop once the lines hold this many characters. */
  chars: number;
  /** Real folders the walk must not enter, and whether names compare without case. */
  refused: string[];
  caseless: boolean;
  skipped: string[];
  maxFileBytes: number;
};

/**
 * The search without ripgrep. It is run as the source of a worker thread (`.toString()`), so it
 * must stay self-contained: no imports, no module-level names, and Node's modules only through
 * `process.getBuiltinModule`, which a bundler leaves alone. Output lines have the shape of
 * `rg --no-heading -n` and are posted per file, so a worker stopped at its deadline leaves the
 * lines it had found. JS regular expressions differ from Rust's at the edges; .gitignore is not
 * read. Hidden entries, binary files and files over `maxFileBytes` are skipped as ripgrep skips
 * them, and a folder it cannot read is left out rather than ending the search.
 */
export function walkSearch(job: WalkJob): void {
  const fs = process.getBuiltinModule('node:fs');
  const path = process.getBuiltinModule('node:path');
  const { parentPort } = process.getBuiltinModule('node:worker_threads');
  const post = (message: unknown) => parentPort?.postMessage(message);
  let expression: RegExp;
  try {
    expression = new RegExp(job.pattern, job.ignoreCase ? 'i' : '');
  } catch (error) {
    post({ problem: error instanceof Error ? error.message : 'Invalid pattern.' });
    return;
  }
  const fold = (value: string) => (job.caseless ? value.toLowerCase() : value);
  const isRefused = (value: string) =>
    job.refused.some((root) => {
      const a = fold(value);
      const b = fold(root);
      return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
    });
  const globMatches = (relative: string) =>
    job.glob === undefined ||
    path.matchesGlob(relative, job.glob) ||
    (!job.glob.includes('/') && path.matchesGlob(path.basename(relative), job.glob));

  let batch: string[] = [];
  let total = 0;
  let chars = 0;
  let done = false;
  let last: { file: string; line: number } | undefined;
  const flush = () => {
    if (batch.length) post({ lines: batch });
    batch = [];
  };
  const emit = (line: string) => {
    batch.push(line);
    total += 1;
    chars += line.length;
    if (total > job.limit || chars > job.chars) done = true;
  };
  /** A group of lines that does not touch the one before is told apart by `--`. */
  const emitRow = (file: string, index: number, hit: boolean, text: string) => {
    if (job.contextLines && last && (last.file !== file || index > last.line + 1)) emit('--');
    emit(`${file}${hit ? ':' : '-'}${index + 1}${hit ? ':' : '-'}${text}`);
    last = { file, line: index };
  };

  const searchFile = (file: string) => {
    let fd: number;
    try {
      fd = fs.openSync(file, 'r');
    } catch {
      return;
    }
    try {
      const size = fs.fstatSync(fd).size;
      if (size > job.maxFileBytes) return;
      const buffer = Buffer.alloc(65536);
      let carry = '';
      const decoder = new (process.getBuiltinModule('node:string_decoder').StringDecoder)('utf8');
      let index = 0;
      let hits = 0;
      let after = 0;
      let first = true;
      const before: Array<{ index: number; text: string }> = [];
      const line = (text: string) => {
        const hit = expression.test(text);
        if (hit) hits += 1;
        if (job.output === 'content') {
          if (hit) {
            for (const earlier of before) emitRow(file, earlier.index, false, earlier.text);
            before.length = 0;
            emitRow(file, index, true, text);
            after = job.contextLines;
          } else if (after > 0) {
            emitRow(file, index, false, text);
            after -= 1;
          } else if (job.contextLines) {
            before.push({ index, text });
            if (before.length > job.contextLines) before.shift();
          }
        }
        index += 1;
        // A file listing needs one match; the rest of the file adds nothing.
        return job.output === 'files' && hit;
      };
      let stop = false;
      while (!stop && !done) {
        const read = fs.readSync(fd, buffer, 0, buffer.length, null);
        if (read === 0) break;
        if (first) {
          first = false;
          if (buffer.subarray(0, Math.min(read, 8000)).includes(0)) return;
        }
        // The decoder holds back a multibyte character that a chunk edge splits.
        carry += decoder.write(buffer.subarray(0, read));
        let at = carry.indexOf('\n');
        while (at !== -1 && !stop && !done) {
          stop = line(carry.slice(0, at));
          carry = carry.slice(at + 1);
          at = carry.indexOf('\n');
        }
      }
      if (!stop && !done && carry) line(carry);
      if (hits) {
        if (job.output === 'files') emit(file);
        else if (job.output === 'count') emit(`${file}:${hits}`);
      }
    } catch {
      // A file that cannot be read is left out.
    } finally {
      fs.closeSync(fd);
      flush();
    }
  };

  const visit = (directory: string, relative: string) => {
    if (done) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const entry of entries) {
      if (done) return;
      if (entry.name.startsWith('.') || job.skipped.includes(entry.name)) continue;
      const full = path.join(directory, entry.name);
      const inner = relative ? `${relative}/${entry.name}` : entry.name;
      if (isRefused(full)) continue;
      if (entry.isDirectory()) visit(full, inner);
      else if (entry.isFile() && globMatches(inner)) searchFile(full);
    }
  };

  try {
    if (fs.statSync(job.target).isDirectory()) visit(job.target, '');
    else if (!isRefused(job.target)) searchFile(job.target);
  } catch (error) {
    post({ problem: error instanceof Error ? error.message : 'Search failed.' });
    return;
  }
  flush();
  post({ done: true, truncated: done });
}
