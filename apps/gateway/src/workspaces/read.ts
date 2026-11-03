import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import type { Skill } from '@jian/contracts';
import { parseSkillDocument } from '../skills/document.js';

const run = promisify(execFile);

/** The project's own instructions, in characters: past this the agent reads the rest itself. */
export const INSTRUCTIONS_CHARS = 32 * 1024;
/** A project skill's file, in characters: one past it is left out. */
const SKILL_CHARS = 64 * 1024;
/** Project skills offered per workspace. */
const SKILLS = 50;
/** Nested instruction files listed per workspace, and how deep they are looked for. */
const NESTED = 20;
const DEPTH = 4;
/** Instruction files, in the order one is preferred to the other. */
const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md'];
const SKILL_FOLDERS = ['.agents/skills', '.claude/skills'];
/** Folders never looked into for nested files, when there is no git to say what it ignores. */
const SKIPPED = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'vendor',
  'target',
  '.next',
]);

/** The files of a workspace that matter here, as read: paths relative to its root. */
export type WorkspaceFiles = {
  files: Array<{ path: string; text: string }>;
  nested: string[];
};

/** What a workspace tells the agent: its instructions, its skills, its other instruction files. */
export type WorkspaceSnapshot = {
  instructions?: { file: string; text: string; cut: boolean };
  skills: Array<Pick<Skill, 'name' | 'description' | 'instructions'> & { file: string }>;
  nested: string[];
};

/** The snapshot of what was read: `AGENTS.md` before `CLAUDE.md`, valid skills only. */
export function digest(read: WorkspaceFiles): WorkspaceSnapshot {
  const instructions = INSTRUCTION_FILES.map((name) =>
    read.files.find((file) => file.path === name),
  ).find(Boolean);
  const skills = read.files
    .filter((file) => /^\.(agents|claude)\/skills\/[^/]+\/SKILL\.md$/.test(file.path))
    .filter((file) => file.text.length <= SKILL_CHARS)
    .flatMap((file) => {
      try {
        const parsed = parseSkillDocument(file.text, file.path.split('/')[2]);
        return [{ ...parsed, file: file.path }];
      } catch {
        // A file that is not a skill is not offered as one.
        return [];
      }
    })
    // One name once: the .agents copy wins over a .claude copy of the same skill.
    .filter((skill, index, all) => all.findIndex((other) => other.name === skill.name) === index)
    .slice(0, SKILLS);

  return {
    ...(instructions
      ? {
          instructions: {
            file: instructions.path,
            text: instructions.text.slice(0, INSTRUCTIONS_CHARS),
            cut: instructions.text.length > INSTRUCTIONS_CHARS,
          },
        }
      : {}),
    skills,
    nested: read.nested
      .filter((path) => INSTRUCTION_FILES.some((name) => path.endsWith(`/${name}`)))
      .filter((path) => path.split('/').length - 1 <= DEPTH)
      .sort()
      .slice(0, NESTED),
  };
}

const readIfThere = async (path: string, limit: number) => {
  try {
    const text = await readFile(path, 'utf8');
    return text.length > limit ? `${text.slice(0, limit)}\u0000` : text;
  } catch {
    return undefined;
  }
};

/** A workspace on this gateway's own disk; undefined when it is not there. */
export async function readLocal(root: string): Promise<WorkspaceFiles | undefined> {
  try {
    if (!(await stat(root)).isDirectory()) return undefined;
  } catch {
    return undefined;
  }

  const files: WorkspaceFiles['files'] = [];
  for (const name of INSTRUCTION_FILES) {
    const text = await readIfThere(join(root, name), INSTRUCTIONS_CHARS + 1);
    if (text !== undefined) files.push({ path: name, text });
  }
  for (const folder of SKILL_FOLDERS) {
    const entries = await readdir(join(root, folder), { withFileTypes: true }).catch(() => []);
    for (const entry of entries.filter((item) => item.isDirectory()).slice(0, SKILLS)) {
      const path = `${folder}/${entry.name}/SKILL.md`;
      const text = await readIfThere(join(root, path), SKILL_CHARS + 1);
      if (text !== undefined && !text.endsWith('\u0000')) files.push({ path, text });
    }
  }

  return { files, nested: await nestedLocal(root) };
}

/** Instruction files below the root: what git tracks or would, else a walk that skips builds. */
async function nestedLocal(root: string): Promise<string[]> {
  try {
    const { stdout } = await run(
      'git',
      ['-C', root, 'ls-files', '-co', '--exclude-standard', '*AGENTS.md', '*CLAUDE.md'],
      { timeout: 3_000, maxBuffer: 1024 * 1024 },
    );
    return stdout.split('\n').filter((path) => path.includes('/'));
  } catch {
    const found: string[] = [];
    const walk = async (folder: string, depth: number) => {
      if (depth > DEPTH || found.length >= NESTED) return;
      const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const path = join(folder, entry.name);
        if (entry.isDirectory() && !SKIPPED.has(entry.name)) await walk(path, depth + 1);
        else if (depth > 0 && INSTRUCTION_FILES.includes(entry.name)) {
          found.push(relative(root, path).split(sep).join('/'));
        }
      }
    };
    await walk(root, 0);
    return found;
  }
}

/** Where one file ends and the next begins in what a machine prints. */
const MARK = '@@JIAN-WORKSPACE';

const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * One command a macOS or Linux machine runs to print the files that matter of `root`, each after
 * a mark: a machine is reached a task at a time, and one round trip is what a turn can wait for.
 */
export function remoteCommand(root: string): string {
  return [
    `cd ${quote(root)} 2>/dev/null || exit 3`,
    `for f in ${INSTRUCTION_FILES.join(' ')}; do [ -f "$f" ] && printf '\\n${MARK} %s\\n' "$f" && head -c ${INSTRUCTIONS_CHARS + 1} "$f"; done`,
    `for f in ${SKILL_FOLDERS.map((folder) => `${folder}/*/SKILL.md`).join(' ')}; do [ -f "$f" ] && printf '\\n${MARK} %s\\n' "$f" && head -c ${SKILL_CHARS + 1} "$f"; done`,
    `printf '\\n${MARK}-NESTED\\n'`,
    `(git ls-files -co --exclude-standard '*AGENTS.md' '*CLAUDE.md' 2>/dev/null || find . -maxdepth ${DEPTH + 1} \\( -name node_modules -o -name .git \\) -prune -o \\( -name AGENTS.md -o -name CLAUDE.md \\) -print | sed 's|^\\./||') | grep / | head -n ${NESTED * 2}`,
  ].join('; ');
}

/** What `remoteCommand` printed, read back; undefined when the folder was not there. */
export function parseRemote(stdout: string, exitCode: number | null): WorkspaceFiles | undefined {
  if (exitCode === 3) return undefined;
  const [body = '', nested = ''] = stdout.split(`\n${MARK}-NESTED\n`);
  const files = body
    .split(`\n${MARK} `)
    .slice(1)
    .flatMap((part) => {
      const newline = part.indexOf('\n');
      if (newline < 0) return [];
      const path = part.slice(0, newline).trim();
      const text = part.slice(newline + 1);
      const limit = INSTRUCTION_FILES.includes(path) ? INSTRUCTIONS_CHARS : SKILL_CHARS;
      // A skill past its size is left out; instructions past theirs are cut, as on the gateway.
      if (!INSTRUCTION_FILES.includes(path) && text.length > limit) return [];
      return [{ path, text }];
    });
  return { files, nested: nested.split('\n').filter(Boolean) };
}
