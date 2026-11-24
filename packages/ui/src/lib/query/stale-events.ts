import { runProgressEventSchema, STREAM_OPENED_EVENT } from '@jian/contracts';
import type { QueryClient, QueryKey } from '@tanstack/react-query';
import type { GatewayEvent } from '../api/events';
import { keys } from './keys';
import { refresh } from './refresh';

/** How long events that arrive together are gathered before one read covers them, in ms. */
const GATHER_MS = 200;
/**
 * The longest a costly read waits while a turn works, in ms. Pull requests walk every checkpoint
 * of the conversation and context loads the last one whole, so a read per step made a long turn
 * cost the square of its steps. The turn's end reads them at once.
 */
const WORKING_MS = 5_000;

/** A key that went stale, and how soon, in ms, what is on screen must be read again. */
export type Stale = { key: QueryKey; within: number };

const soon = (...stale: QueryKey[]): Stale[] => stale.map((key) => ({ key, within: GATHER_MS }));
const paced = (...stale: QueryKey[]): Stale[] => stale.map((key) => ({ key, within: WORKING_MS }));

/** A progress frame names its conversation, when the gateway is recent enough to. */
function contextOf(event: GatewayEvent, profileId: string): QueryKey {
  const sessionId = (event.data as { sessionId?: unknown } | undefined)?.sessionId;
  return typeof sessionId === 'string'
    ? keys.sessionContext(profileId, sessionId)
    : keys.contexts(profileId);
}

/**
 * What an event makes stale. A turn changes the conversations and the work in progress; the
 * agent editing itself changes the profile list; a contact or a channel can touch any slice of
 * the profile. None of them asks the providers for their models again.
 */
export function affected(event: GatewayEvent, profileId: string): Stale[] {
  const { type } = event;

  // Nothing before this was told, so what the screens read while it opened may have missed some.
  // A stream opens again after the gateway restarts, as it does on an update: its release too.
  if (type === STREAM_OPENED_EVENT) {
    return soon(
      keys.activities(profileId),
      keys.sessions(profileId),
      keys.contexts(profileId),
      keys.sessionPulls(profileId),
      keys.sessionProcesses(profileId),
      keys.releases,
    );
  }
  if (type.startsWith('contact.') || type.startsWith('channel.')) {
    return soon(keys.profile(profileId));
  }
  // A step taken or a context compacted moves how full the context is.
  if (type === 'run.progress') {
    return [...soon(keys.activities(profileId)), ...paced(contextOf(event, profileId))];
  }
  if (type.startsWith('run.') || type.startsWith('session.')) {
    // Neither a step nor a paragraph ends the turn, whose own end reads all of this at once.
    const during = type === 'run.step' || type === 'session.message';
    const costly = [keys.contexts(profileId), keys.sessionPulls(profileId)];
    return [
      ...soon(keys.activities(profileId), keys.sessions(profileId)),
      ...(during ? paced(...costly) : soon(...costly)),
      // A worktree is made, merged or discarded by a turn, and its counts move as the turn
      // commits. Read again when the turn starts or ends, or one changes: not on each step or
      // each paragraph said, since on a machine every read is a task its worker runs.
      ...(during ? [] : soon(keys.sessionWorktrees(profileId))),
    ];
  }
  // A command the agent started in the background began or ended.
  if (type.startsWith('process.')) return soon(keys.sessionProcesses(profileId));
  if (type.startsWith('profile.')) return soon(keys.profiles);
  if (type.startsWith('memory.')) return soon(keys.memories(profileId));
  // The agent writes schedules too, and every run changes when one ran last.
  if (type.startsWith('schedule.')) return soon(keys.schedules(profileId));
  // A merge made in another tab or window: its references and drawer read it again.
  if (type === 'github.pull.merged') {
    return soon(['integrations', 'github', 'links'], ['integrations', 'github', 'pull']);
  }

  return [];
}

/** How many runs' last activity is remembered before the memory starts over. */
const RUNS_REMEMBERED = 64;

/**
 * What each event makes stale, remembering what each working run was last told doing. A progress
 * frame comes four times a second while a run writes, and the lists it would read again carry the
 * text: every screen showing them would draw again for words only the conversation shows. Only a
 * change of phase, tool or step count is news to them. A frame without progress, from an older
 * gateway, says only that the run moved, and is taken as news every time.
 */
export function staleOf(profileId: string) {
  const doing = new Map<string, string>();

  return (event: GatewayEvent): Stale[] => {
    if (event.type === 'run.progress') {
      const told = runProgressEventSchema.safeParse(event.data);
      const progress = told.success ? told.data.progress : undefined;
      if (told.success && progress) {
        const now = JSON.stringify([progress.phase, progress.tool, progress.steps]);
        if (doing.get(told.data.runId) === now) return [];
        if (doing.size >= RUNS_REMEMBERED) doing.clear();
        doing.set(told.data.runId, now);
      }
    }

    return affected(event, profileId);
  };
}

/**
 * Reads what went stale, each key once within how soon it asked for. The mark is set at once, so
 * a conversation not on screen reads its own again as soon as it is opened, whatever the wait;
 * a wait already shorter is never put off, so a long turn cannot keep a key from being read.
 */
export function staleReads(client: QueryClient) {
  const waiting = new Map<string, { at: number; timer: ReturnType<typeof setTimeout> }>();

  return {
    tell(stale: Stale[]) {
      for (const { key, within } of stale) {
        void client.invalidateQueries({ queryKey: key, refetchType: 'none' });
        const id = JSON.stringify(key);
        const at = Date.now() + within;
        const known = waiting.get(id);
        if (known && known.at <= at) continue;
        if (known) clearTimeout(known.timer);
        const timer = setTimeout(() => {
          waiting.delete(id);
          void refresh(client, key);
        }, within);
        waiting.set(id, { at, timer });
      }
    },
    /** What was waiting keeps its mark, and is read when a screen next asks for it. */
    stop() {
      for (const { timer } of waiting.values()) clearTimeout(timer);
      waiting.clear();
    },
  };
}
