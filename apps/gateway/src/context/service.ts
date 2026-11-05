import type { Session } from '@jian/contracts';
import {
  GATEWAY_SESSION_CHANNEL,
  LEARNING_SESSION_CHANNEL,
  type McpServer,
  type Run,
} from '@jian/contracts';
import { and, eq, inArray } from 'drizzle-orm';
import { onOwnerComputer, projectCheckout, workspaceHome } from '../agent/workspace-home.js';
import { listConversations } from '../channels/repository.js';
import type { Judge } from '../decisions/service.js';
import { findMemories, searchMemories, withLinks } from '../memories/repository.js';
import type { RunReader } from '../runs/port.js';
import { listContextToolCheckpoints } from '../runs/repository.js';
import { listLoads } from '../sessions/loads.js';
import type { SessionReader } from '../sessions/port.js';
import { availableSkills } from '../skills/builtin/index.js';
import type { Store } from '../storage/database.js';
import { projects } from '../storage/schema.js';
import type { FolderSignal, Worktrees } from '../worktrees/service.js';
import { buildContext, rankMemories, withTurnNote } from './build.js';
import { judgeTurn } from './judgments.js';
import type { ContextSource } from './port.js';
import { toolRecordsByRun, withToolHistory } from './tool-history.js';

/** What a chat works on beyond one project: told to the agent, since it is why it is here. */
function workspaceGuidance(
  session: Pick<Session, 'folders' | 'cloneInto' | 'remoteMachineId'>,
  repositories: { name: string; url: string }[],
): string {
  const parts: string[] = [];
  const list = (items: string[]) => items.map((item) => JSON.stringify(item)).join(', ');

  if (session.folders?.length) {
    parts.push(
      session.remoteMachineId
        ? `This conversation works on these folders of the owner's, on that machine: ${list(session.folders)}. Run commands there, with cwd set to the folder.`
        : `This conversation works on these folders of the owner's, on this computer: ${list(session.folders)}. Your commands start in the first. Read and change files there with your usual tools, and touch nothing else of theirs.`,
    );
  }
  if (repositories.length) {
    parts.push(
      `This conversation works on these repositories at once: ${list(repositories.map((item) => item.name))}. Clone, fetch, pull and push each with github_git, naming it; its default path is this conversation's own checkout of it.`,
    );
  }
  if (session.cloneInto) {
    parts.push(
      `The owner chose where its repositories go on the machine: clone them under ${JSON.stringify(session.cloneInto)}, which github_git does by default.`,
    );
  }
  return parts.join('\n\n');
}

const files = (count: number) => `${count} ${count === 1 ? 'file' : 'files'}`;

/**
 * What a turn tells the agent about the folders it works in, in two parts because they change at
 * different rates. `steady` is the worktree it works in, which changes when the agent says so and
 * belongs in the cached system prompt. `turn` is the uncommitted count and who else is there,
 * which change under it and so go in the turn context. Another agent is named by its own name
 * only, because its conversations are private to it.
 */
export function worktreeSignals(
  signals: readonly FolderSignal[],
  machine: boolean,
): { steady: string[]; turn: string[] } {
  const steady: string[] = [];
  const turn: string[] = [];

  for (const { folder, uncommitted, others, worktree } of signals) {
    if (worktree) {
      // Guards and the cwd remap exist on the gateway only: a machine's commands are told apart.
      const start = machine
        ? `. Your tools do not reach a machine: set cwd of run_remote_command to ${worktree.path}.`
        : '; your tools start there.';
      steady.push(
        `${folder}: You work on it in the worktree ${worktree.name} at ${worktree.path} (branch ${worktree.branch} from ${worktree.base})${start}`,
      );
    }
    const parts = [
      ...(worktree || uncommitted === undefined
        ? []
        : [
            uncommitted === 0
              ? 'No uncommitted changes.'
              : // The agent's own edits of earlier turns are there too, and are not the owner's.
                `${files(uncommitted)} with uncommitted changes. Changes you made in this conversation count too.`,
          ]),
      ...others.map((other) =>
        other.agent
          ? `Another agent, ${other.agent}, is working here now.`
          : `Another conversation of yours, ${JSON.stringify(other.conversation)}, is working here now.`,
      ),
      ...(worktree ? [] : ['You have no worktree for it.']),
    ];
    if (parts.length && (!worktree || others.length)) turn.push(`${folder}: ${parts.join(' ')}`);
  }
  return { steady, turn };
}

/** What a subagent is told about a separate checkout, by what its run can do. */
function worktreeAdvice(worktrees?: { create: boolean; machine: boolean }): string {
  if (!worktrees) return '';
  if (worktrees.machine) {
    return " The conversation's worktrees are on its machine: list_worktrees shows them, and to work in one, run commands there with run_remote_command and set its cwd to the worktree path.";
  }
  return worktrees.create
    ? " If this assignment needs a checkout of its own, call create_worktree with the repository folder: it makes your worktree from the conversation's worktree when it has one for it, and from the folder otherwise, and merge_worktree brings it back to where it came from when your work is done."
    : " The conversation's worktrees are yours to use: list_worktrees shows them. Pass the path of the one your brief names as cwd when you run a command.";
}

export class Contexts {
  constructor(
    private readonly store: Store,
    private readonly runs: RunReader,
    private readonly sessions: SessionReader,
    private readonly settings?: { timeZone(): Promise<string> },
    /** Reads the shortlist for meaning when the installation has a Jev key; see judgments.ts. */
    private readonly judge?: Judge,
    /** Who else works in the conversation's folders, and its own worktrees. */
    private readonly worktrees?: Pick<Worktrees, 'signals'>,
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
    return withToolHistory(history, toolRecordsByRun(checkpoints, summary), run.id);
  }

  async context(
    run: Run,
    servers: readonly McpServer[],
    workspaces?: Parameters<ContextSource['context']>[2],
  ): ReturnType<ContextSource['context']> {
    const worker = run.subagent;
    const words = [...new Set(run.input.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? [])].slice(
      0,
      12,
    );

    const session = await this.sessions.session(run.profileId, run.sessionId);

    // Independent reads: whatever the request mentions, what the profile is busy with, whom it
    // talks to on its channels, and the turns since the record of what was compacted away.
    // `buildContext` is what decides how much of each survives.
    const [matched, activities, conversations, history, project] = await Promise.all([
      worker ? [] : searchMemories(this.store.db, run.profileId, words, 100),
      worker ? [] : this.runs.activities(run.profileId),
      worker ? [] : listConversations(this.store.db, run.profileId),
      this.sessions.uncompactedMessages(
        run.profileId,
        run.sessionId,
        session.summarizedThroughId,
        // Older checkpoints stored only a timestamp. After continuous-context stopped capping
        // history at 40 turns, a missing through_id reloads the covered transcript beside the
        // summary and blows the model window on long upgraded sessions.
        session.summarizedThroughId ? undefined : session.summarizedUpTo,
      ),
      !worker && session.projectId
        ? this.store.db
            .select()
            .from(projects)
            .where(and(eq(projects.profileId, run.profileId), eq(projects.id, session.projectId)))
            .then(([row]) => row)
        : null,
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
            skills: availableSkills(run.profile, servers, {
              worktrees: Boolean(workspaces?.worktrees),
            }).map(({ name, description }) => ({
              name,
              description,
            })),
          })
        : {};

    const currentIndex = history.findIndex(
      (message) => message.runId === run.id && message.role === 'user',
    );
    const earlier = currentIndex < 0 ? history : history.slice(0, currentIndex);
    const previous = earlier.at(-1);
    let workerGuidance: string | undefined;
    if (worker) {
      const home = await workspaceHome();
      const repositories = worker.repositories ?? [];
      workerGuidance = [
        `You are ${JSON.stringify(worker.name)}, an ephemeral ${worker.role} worker for one task.`,
        `Identity and working approach: ${worker.identity}`,
        `Your $HOME is ${home}, the same as the principal agent's (same cwd roots and repository checkouts), and every agent of this installation shares these files, so they may change while you work; touch only what the assignment names. ${repositories.length ? `Named repository roots for this assignment: ${repositories.join(', ')}.` : onOwnerComputer() ? "Use the repositories the brief names; this is the owner's own computer." : 'Use repositories under this directory as needed.'} ${worktreeAdvice(workspaces?.worktrees)}`,
        'Work only on the assignment in your opening message. Your parent conversation is not in this context; use the brief and available tools. Do not create tasks or spawn another subagent. Report verified outcomes and exact blockers in your final response.',
        'Your final response is a factual report to the principal agent, not a message to the owner.',
      ].join('\n\n');
    }
    // A project bound to a GitHub repository is cloned, fetched, pulled and pushed with the
    // App's token through github_git; any other repository with git and the SSH keys.
    const github = project?.githubRepositoryId
      ? /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(project.repositoryUrl)?.[1]
      : undefined;
    const gitWay = github
      ? ` Clone, fetch, pull and push it with github_git (repository ${github}), not git in the shell, which reaches GitHub only with SSH keys; use git in the shell for everything local.`
      : '';
    const several =
      !worker && session.projectIds?.length
        ? await this.store.db
            .select({ name: projects.name, url: projects.repositoryUrl })
            .from(projects)
            .where(
              and(eq(projects.profileId, run.profileId), inArray(projects.id, session.projectIds)),
            )
        : [];
    // Whatever the folders say: a conversation that clones into one of the owner's has its
    // checkouts there, and one with a worktree works on its source.
    const signals =
      !worker && workspaces?.worktrees && this.worktrees
        ? worktreeSignals(
            await this.worktrees.signals(run.profileId, session).catch(() => []),
            workspaces.worktrees.machine,
          )
        : { steady: [], turn: [] };
    const workspace = worker
      ? ''
      : [workspaceGuidance(session, several), ...signals.steady].filter(Boolean).join('\n\n');
    const projectGuidance = project
      ? session.remoteMachineId
        ? `This conversation belongs to the coding project ${JSON.stringify(project.name)}. Repository: ${project.repositoryUrl}.${gitWay} This conversation targets one of the owner's machines; clone the repository there into a dedicated checkout before changing files, and keep all project work on that machine.`
        : `This conversation belongs to the coding project ${JSON.stringify(project.name)}. Repository: ${project.repositoryUrl}.${gitWay} Use this conversation's checkout directory: ${JSON.stringify(await projectCheckout(run.profileId, project.id, session.id))}. ${github ? 'If it is not checked out yet, clone it with github_git, which clones into that path by default,' : 'If it is not checked out yet, create its parent directory with mkdir -p and clone this repository into that path'} before changing files. Keep this conversation's work in that checkout and report commands and verification performed.`
      : undefined;
    const guidance = [workspace, projectGuidance, workerGuidance].filter((part): part is string =>
      Boolean(part),
    );
    const built = buildContext(run, {
      servers,
      ...(workspaces?.worktrees ? { worktrees: true } : {}),
      ...(judged.relevance ? { relevance: judged.relevance } : {}),
      ...(judged.skill ? { suggestedSkill: judged.skill } : {}),
      ...(this.settings ? { timeZone: await this.settings.timeZone() } : {}),
      memories,
      linked,
      activities,
      // Name this conversation directly; there is no longer a profile-wide default chat.
      conversations: [
        ...(!worker && session.channel === GATEWAY_SESSION_CHANNEL
          ? [{ sessionId: session.id, channel: 'gateway', with: 'your owner, in Jian Chats' }]
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
      ...(session.objective ? { objective: session.objective } : {}),
      ...(guidance.length ? { guidance } : {}),
      ...(workspaces?.sections.length ? { project: workspaces.sections } : {}),
      ...(workspaces?.skills.length ? { projectSkills: workspaces.skills } : {}),
      loadedSkills: (await listLoads(this.store.db, run.profileId, run.sessionId))
        .filter((load) => load.kind === 'skill')
        .map((load) => load.name),
    });

    // The count and who else is there change under the agent: said in the turn, so the cached
    // prefix stays as it was.
    if (signals.turn.length) {
      withTurnNote(built, `Where you work now:\n${signals.turn.join('\n')}`);
    }
    const result = {
      ...built,
      ...(previous ? { historyCursor: { id: previous.id, createdAt: previous.createdAt } } : {}),
    };
    return judged.light ? { ...result, light: true as const } : result;
  }
}
