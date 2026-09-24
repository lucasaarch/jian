import type { Run } from '@jian/contracts';
import { listConversations } from '../channels/repository.js';
import { findMemories, searchMemories, withLinks } from '../memories/repository.js';
import type { RunReader } from '../runs/port.js';
import type { SessionReader } from '../sessions/port.js';
import { findGatewaySession } from '../sessions/repository.js';
import type { Store } from '../storage/database.js';
import { buildContext } from './build.js';

export class Contexts {
  constructor(
    private readonly store: Store,
    private readonly runs: RunReader,
    private readonly sessions: SessionReader,
    private readonly settings?: { timeZone(): Promise<string> },
  ) {}

  async context(run: Run) {
    const words = [...new Set(run.input.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? [])].slice(
      0,
      12,
    );

    const session = await this.sessions.session(run.profileId, run.sessionId);

    // Independent reads: whatever the request mentions, what the profile is busy with, whom it
    // talks to on its channels, and the turns since the record of what was compacted away.
    // `buildContext` is what decides how much of each survives.
    const [matched, activities, gateway, conversations, history] = await Promise.all([
      searchMemories(this.store.db, run.profileId, words, 100),
      this.runs.activities(run.profileId),
      findGatewaySession(this.store.db, run.profileId),
      listConversations(this.store.db, run.profileId),
      this.sessions.messages(run.profileId, run.sessionId, 40, session.summarizedUpTo),
    ]);

    // One step out from what matched: the memories linked to it, which the request may not
    // mention at all.
    const memories = await withLinks(this.store.db, run.profileId, matched);
    const matchedKeys = new Set(memories.map((memory) => memory.key));
    const linked = await findMemories(
      this.store.db,
      run.profileId,
      [...new Set(memories.flatMap((memory) => memory.links ?? []))].filter(
        (key) => !matchedKeys.has(key),
      ),
    );

    return buildContext(run, {
      ...(this.settings ? { timeZone: await this.settings.timeZone() } : {}),
      memories,
      linked,
      activities,
      // The owner's own conversation, from the panel, comes first: it is where they reach the
      // agent directly, and without it the agent believes the conversation it is in is missing.
      conversations: [
        ...(gateway
          ? [{ sessionId: gateway.id, channel: 'gateway', with: 'your owner, in the Jian panel' }]
          : []),
        ...conversations.map((contact) => ({
          sessionId: contact.sessionId as string,
          channel: contact.type,
          with: contact.displayName ?? contact.actorId,
          ...(contact.scope === 'group' ? { group: true } : {}),
        })),
      ],
      history,
      ...(session.summary ? { summary: session.summary } : {}),
    });
  }
}
