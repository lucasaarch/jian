import type { Profile, ProfilePatch } from './api';
import { panelApi } from './query/client';

/**
 * Edits to one agent, saved one after another. Every save names the version it was made
 * against, so two cards saving at once (the identity and when it compacts) would both send the
 * same version, and the second would be refused as stale. Queued per agent, each save waits for
 * the one before it and sends the version that one returned.
 */
const queues = new Map<string, Promise<unknown>>();
/** The newest version a save here returned, per agent. Versions only grow. */
const saved = new Map<string, number>();

export function saveProfile(
  profile: Pick<Profile, 'id' | 'version'>,
  patch: Omit<ProfilePatch, 'expectedVersion'>,
): Promise<Profile> {
  const run = async () => {
    const expectedVersion = Math.max(saved.get(profile.id) ?? 0, profile.version);
    const next = await panelApi().updateProfile(profile.id, { ...patch, expectedVersion });
    saved.set(profile.id, next.version);
    return next;
  };
  // A save that failed does not hold back the next one, which says why it failed itself.
  const next = (queues.get(profile.id) ?? Promise.resolve()).catch(() => undefined).then(run);
  queues.set(profile.id, next);
  return next;
}
