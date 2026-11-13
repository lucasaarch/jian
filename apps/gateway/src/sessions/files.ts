import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  SESSION_FILE_MAX_BYTES,
  SESSION_FILES_MAX,
  type Session,
  type SessionFile,
  type SessionFileRoot,
} from '@jian/contracts';
import { and, eq, inArray } from 'drizzle-orm';
import { projectCheckout, sessionCheckouts } from '../agent/workspace-home.js';
import { GatewayError } from '../core/errors.js';
import type { Store } from '../storage/database.js';
import { projects } from '../storage/schema.js';
import { checkoutReader, inside, openCheckout, readChanges, readInside } from './changes.js';

/** `ls-files` of a checkout at the listing cap, with room for long paths; past it the root says why. */
const MAX_LIST_BYTES = 8_000_000;
/** A NUL this early is how git itself tells a binary file from text. */
const BINARY_PROBE_BYTES = 8000;
const MAX_ROOTS = 50;

/** One folder a conversation's files are read from. `base` is a worktree's base branch. */
export type FileRoot = { id: string; name: string; path: string; base?: string };

type WorktreeRecord = { name: string; path: string; base: string; place: string };

/**
 * A conversation on several repositories clones each into a folder named after the repository,
 * as `github_git` defaults to. A name that is not one plain folder is no checkout of ours.
 */
function repositoryFolder(url: string): string | undefined {
  const name = /([^/\\:]+?)(?:\.git)?\/*$/.exec(url)?.[1];
  return name && name !== '.' && name !== '..' ? name : undefined;
}

/**
 * The folders this conversation's files come from: its own worktrees on the gateway, which is
 * where its tools work once it has one, otherwise the checkout of each of its projects. Never the
 * source folder of a worktree, another conversation's checkout, or a path a request supplied.
 */
export async function sessionFileRoots(
  db: Store['db'],
  profileId: string,
  session: Session,
  worktrees: WorktreeRecord[],
): Promise<FileRoot[]> {
  if (session.remoteMachineId) {
    throw new GatewayError(409, "Files of a conversation on a machine can't be shown yet.");
  }
  const own = worktrees.filter((item) => item.place === 'gateway');
  if (own.length) {
    return own.slice(0, MAX_ROOTS).map((item) => ({
      id: `worktree:${item.name}`,
      name: item.name,
      path: item.path,
      base: item.base,
    }));
  }
  if (session.projectId) {
    const [project] = await db
      .select({ id: projects.id, name: projects.name })
      .from(projects)
      .where(and(eq(projects.id, session.projectId), eq(projects.profileId, profileId)))
      .limit(1);
    if (project) {
      return [
        {
          id: project.id,
          name: project.name.slice(0, 200),
          path: await projectCheckout(profileId, project.id, session.id),
        },
      ];
    }
  }
  const ids = (session.projectIds ?? []).slice(0, MAX_ROOTS);
  const found = ids.length
    ? await db
        .select({ id: projects.id, name: projects.name, url: projects.repositoryUrl })
        .from(projects)
        .where(and(eq(projects.profileId, profileId), inArray(projects.id, ids)))
    : [];
  if (!found.length) {
    throw new GatewayError(409, 'This conversation has no project whose files could be shown.');
  }
  const checkouts = await sessionCheckouts(profileId, session.id);
  // In the order the conversation names its projects, so the tree does not reshuffle.
  return ids.flatMap((id) => {
    const project = found.find((item) => item.id === id);
    if (!project) return [];
    const folder = repositoryFolder(project.url);
    return [
      {
        id: project.id,
        name: project.name.slice(0, 200),
        // No folder to name: nothing is ever cloned under an id, so it reads as not checked out.
        path: join(checkouts, folder ?? project.id),
      },
    ];
  });
}

/**
 * The files of one root and which of them changed. A root that cannot be read (not cloned yet, no
 * git checkout, too large) still answers, with why, so one of several does not hide the others.
 */
export async function listRootFiles(root: FileRoot): Promise<SessionFileRoot> {
  try {
    const checkout = await openCheckout(root.path);
    const reader = checkoutReader(checkout);
    const against = root.base ? await reader.mergeBase(root.base) : 'HEAD';
    // Status first: it is what turns the repository's own filters off for every read after it.
    const changes = await readChanges(reader, undefined, false, against);
    const listed = await checkout.git(
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      MAX_LIST_BYTES,
    );
    if (listed.code !== 0) throw new GatewayError(409, 'The checkout files could not be read.');
    // A conflicted path is in the index once per stage.
    const files = [
      ...new Set(listed.stdout.split('\0').filter((path) => path && path.length <= 4096)),
    ];
    return {
      id: root.id,
      name: root.name,
      files: files.slice(0, SESSION_FILES_MAX),
      changes: changes.files.map(({ path, previousPath, status }) => ({
        path,
        ...(previousPath ? { previousPath } : {}),
        status,
      })),
      truncated: files.length > SESSION_FILES_MAX,
    };
  } catch (error) {
    if (!(error instanceof GatewayError)) throw error;
    const missing = error.message === 'This conversation has no checkout yet.';
    return {
      id: root.id,
      name: root.name,
      files: [],
      changes: [],
      truncated: false,
      unavailable: (missing
        ? 'Not checked out yet: the agent clones it when it first works on it.'
        : error.message
      ).slice(0, 500),
    };
  }
}

const notFound = () => new GatewayError(404, 'That file is not in this checkout.');

/**
 * One file of a root as it is on disk now. The path is the request's, so it is held to the
 * checkout three times: as text (relative, no `..`, nothing of git's own), as a resolved path, and
 * on the open descriptor. A link may point elsewhere in the checkout, never out of it.
 */
export async function readRootFile(root: FileRoot, path: string): Promise<SessionFile> {
  const parts = path.split(process.platform === 'win32' ? /[\\/]/ : '/');
  if (
    isAbsolute(path) ||
    path.includes('\0') ||
    parts.some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')
  ) {
    throw notFound();
  }
  const { root: checkout } = await openCheckout(root.path);
  const target = resolve(checkout, ...parts);
  if (!inside(checkout, target)) throw notFound();
  const real = await realpath(target).catch(() => undefined);
  const info = real ? await stat(real).catch(() => undefined) : undefined;
  if (!real || !info) throw notFound();
  const unavailable = (reason: string, size = info.size): SessionFile => ({
    root: root.id,
    path,
    size,
    unavailable: reason,
  });
  if (!inside(checkout, real)) return unavailable('This link points outside the checkout.', 0);
  // A link inside the checkout may still lead into git's own folder, which holds its config.
  if (
    relative(checkout, real)
      .split(sep)
      .some((part) => part.toLowerCase() === '.git')
  )
    throw notFound();
  if (!info.isFile()) throw notFound();
  if (info.size > SESSION_FILE_MAX_BYTES) return unavailable('This file is too large to show.');

  const read = await readInside(checkout, target, real, SESSION_FILE_MAX_BYTES);
  if ('refused' in read) {
    if (read.refused === 'special') throw notFound();
    return read.refused === 'outside'
      ? unavailable('This link points outside the checkout.', 0)
      : read.refused === 'large'
        ? unavailable('This file is too large to show.')
        : unavailable('The file changed while it was being read.');
  }
  const size = read.bytes.length;
  if (read.bytes.subarray(0, BINARY_PROBE_BYTES).includes(0)) {
    return unavailable('This is a binary file.', size);
  }
  return { root: root.id, path, size, text: read.bytes.toString('utf8') };
}
