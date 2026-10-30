'use client';

import type { Memory } from '../../lib/api';
import type { SectionActions } from '../props';

/** The same bounds the gateway puts on a memory and on its links. */
export const MEMORY_CONTENT_LIMIT = 4000;
export const MEMORY_LINK_LIMIT = 12;

/** The memories whose key or text holds what was typed; all of them when nothing was. */
export function matchingMemories(memories: Memory[], query: string): Memory[] {
  const terms = query.trim().toLowerCase();

  return memories.filter((item) =>
    terms ? `${item.key} ${item.content}`.toLowerCase().includes(terms) : true,
  );
}

/** The memories this one could be linked to: neither itself nor one it is linked to already. */
export function linkCandidates(memory: Memory, all: Memory[]): Memory[] {
  const links = memory.links ?? [];

  return all.filter((item) => item.key !== memory.key && !links.includes(item.key));
}

/** What forgetting a memory takes with it, said before it is done. */
export function forgetNote(memory: Memory): string {
  return `The agent stops reading this entry on its next runs${
    memory.links?.length ? ', and its links go with it' : ''
  }. This cannot be undone.`;
}

/**
 * What the owner can do to the agent's memories. A rewrite saves as a new version against the
 * one on screen, so an agent writing meanwhile is not overwritten; a link changes at once. Each
 * resolves false when it failed, after saying so.
 */
export function memoryActions(
  { api, mutate }: Pick<SectionActions, 'api' | 'mutate'>,
  profileId: string,
) {
  return {
    save: (memory: Memory, content: string) =>
      mutate(() => api.editMemory(profileId, memory.key, content, memory.version), 'Memory saved.'),
    link: (memory: Memory, key: string) =>
      mutate(() => api.linkMemories(profileId, memory.key, key), `Linked to ${key}.`),
    unlink: (memory: Memory, key: string) =>
      mutate(() => api.unlinkMemories(profileId, memory.key, key), `Unlinked from ${key}.`),
    forget: (memory: Memory) => mutate(() => api.forget(profileId, memory.key), 'Memory deleted.'),
  };
}
