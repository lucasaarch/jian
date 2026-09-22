import type { Run } from '@jian/contracts';
import { searchMemories } from '../memories/repository.js';
import type { RunReader } from '../runs/port.js';
import type { SessionReader } from '../sessions/port.js';
import type { Store } from '../storage/database.js';
import { buildContext } from './build.js';

export class Contexts {
  constructor(
    private readonly store: Store,
    private readonly runs: RunReader,
    private readonly sessions: SessionReader,
  ) {}

  async context(run: Run) {
    const words = [...new Set(run.input.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? [])].slice(
      0,
      12,
    );

    const session = await this.sessions.session(run.profileId, run.sessionId);

    // Four independent reads: whatever the request mentions, what the profile is busy with,
    // the record of what was compacted away, and the turns since. `buildContext` is what
    // decides how much of each survives.
    const [memories, activities, history] = await Promise.all([
      searchMemories(this.store.db, run.profileId, words, 100),
      this.runs.activities(run.profileId),
      this.sessions.messages(run.profileId, run.sessionId, 40, session.summarizedUpTo),
    ]);

    return buildContext(run, {
      memories,
      activities,
      history,
      ...(session.summary ? { summary: session.summary } : {}),
    });
  }
}
