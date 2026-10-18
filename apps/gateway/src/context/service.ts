import { basename, join } from 'node:path';
import { LEARNING_SESSION_CHANNEL, type Run } from '@jian/contracts';
import { workspaceOf } from '../agent/workspace.js';
import { listConversations } from '../channels/repository.js';
import type { Judge } from '../decisions/service.js';
import { findMemories, searchMemories, withLinks } from '../memories/repository.js';
import type { RunReader } from '../runs/port.js';
import { listContextToolCheckpoints } from '../runs/repository.js';
import type { SessionReader } from '../sessions/port.js';
import { findGatewaySession } from '../sessions/repository.js';
import { availableSkills } from '../skills/builtin/index.js';
import type { Store } from '../storage/database.js';
import { buildContext, rankMemories } from './build.js';
import { judgeTurn } from './judgments.js';
import type { ContextSource } from './port.js';
import { toolHistoryByRun, withToolHistory } from './tool-history.js';

export class Contexts {
  constructor(
    private readonly store: Store,
    private readonly runs: RunReader,
    private readonly sessions: SessionReader,
    private readonly settings?: { timeZone(): Promise<string> },
    /** Reads the shortlist for meaning when the installation has a Jev key; see judgments.ts. */
    private readonly judge?: Judge,
  ) {}

  private async historyWithTools(
    run: Run,
    history: Awaited<ReturnType<SessionReader['messages']>>,
    summary?: string,
  ) {
    const runIds = [
      ...new Set(
        history.flatMap((message) =>
          message.runId && message.runId !== run.id ? [message.runId] : [],
        ),
      ),
    ];
    const checkpoints = await listContextToolCheckpoints(this.store.db, run.profileId, runIds);
    return withToolHistory(history, toolHistoryByRun(checkpoints, summary), run.id);
  }

  async context(run: Run): ReturnType<ContextSource['context']> {
    const worker = run.subagent;
    const words = [...new Set(run.input.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? [])].slice(
      0,
      12,
    );

    const session = await this.sessions.session(run.profileId, run.sessionId);

    // Independent reads: whatever the request mentions, what the profile is busy with, whom it
    // talks to on its channels, and the turns since the record of what was compacted away.
    // `buildContext` is what decides how much of each survives.
    const [matched, activities, gateway, conversations, history] = await Promise.all([
      worker ? [] : searchMemories(this.store.db, run.profileId, words, 100),
      worker ? [] : this.runs.activities(run.profileId),
      worker ? null : findGatewaySession(this.store.db, run.profileId),
      worker ? [] : listConversations(this.store.db, run.profileId),
      this.sessions.uncompactedMessages(run.profileId, run.sessionId, session.summarizedThroughId),
    ]);

    // One step out from what matched: the memories linked to it, which the request may not
    // mention at all.
    const memories = worker ? [] : await withLinks(this.store.db, run.profileId, matched);
    const matchedKeys = new Set(memories.map((memory) => memory.key));
    const linked = await findMemories(
      this.store.db,
      run.profileId,
      [...new Set(memories.flatMap((memory) => memory.links ?? []))].filter(
        (key) => !matchedKeys.has(key),
      ),
    );

    const before = history.findLast(
      (message) => message.role === 'assistant' && message.runId !== run.id,
    )?.content;
    // A look back reads its own brief and loads no skill; judging it would only cost a call.
    const judged =
      this.judge && !worker && session.channel !== LEARNING_SESSION_CHANNEL
        ? await judgeTurn(this.judge, {
            request: run.input,
            ...(before ? { before } : {}),
            memories: rankMemories(run.input, memories).map(({ memory }) => memory),
            skills: availableSkills(run.profile).map(({ name, description }) => ({
              name,
              description,
            })),
          })
        : {};

    const built = buildContext(run, {
      ...(judged.relevance ? { relevance: judged.relevance } : {}),
      ...(judged.skill ? { suggestedSkill: judged.skill } : {}),
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
      history: await this.historyWithTools(run, history, session.summary),
      ...(session.summary ? { summary: session.summary } : {}),
    });

    const currentIndex = history.findIndex(
      (message) => message.runId === run.id && message.role === 'user',
    );
    const earlier = currentIndex < 0 ? history : history.slice(0, currentIndex);
    const previous = earlier.at(-1);
    let workerGuidance: string | undefined;
    if (worker) {
      const home = await workspaceOf(run.profileId, run.id);
      const repositories = (worker.repositories ?? []).map((source, index) =>
        join(home, 'repos', String(index + 1), basename(source)),
      );
      workerGuidance = [
        `You are ${JSON.stringify(worker.name)}, an ephemeral ${worker.role} worker for one task.`,
        `Identity and working approach: ${worker.identity}`,
        `Your workspace is ${home}. ${repositories.length ? `Your repository worktrees are ${repositories.join(', ')}.` : 'Clone repositories under this workspace when needed.'} Paths from other workers' reports are not accessible to you. For review, fetch the committed branch or PR into your own worktree; do not open another worker's directory. If changes exist only in that worker's uncommitted files, report the missing handoff instead of attempting to bypass isolation.`,
        run.workItemId
          ? 'Work only on the assigned legacy task. Its card is archived and read-only. Report verified outcomes and exact blockers in your final response.'
          : 'Work only on the assignment in your opening message. Your parent conversation is not in this context; use the brief and available tools. Do not create tasks or spawn another subagent. Report verified outcomes and exact blockers in your final response.',
        'Your final response is a factual report to the principal agent, not a message to the owner.',
      ].join('\n\n');
    }
    const result = {
      ...built,
      ...(workerGuidance ? { system: `${built.system}\n\n${workerGuidance}` } : {}),
      ...(previous ? { historyCursor: { id: previous.id, createdAt: previous.createdAt } } : {}),
    };
    return judged.light ? { ...result, light: true as const } : result;
  }
}
