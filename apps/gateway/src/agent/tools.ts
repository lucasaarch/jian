import {
  agentCallSchema,
  conversationSubagentInputSchema,
  decisionUseSchema,
  inspectorFocusInputSchema,
  MAX_OBJECTIVE_TEXT,
  type McpServer,
  memoryKeySchema,
  memorySchema,
  messageReactionInputSchema,
  type Run,
  type Skill,
} from '@jian/contracts';
import { type ToolSet, tool } from 'ai';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { isChatChannel } from '../channels/kinds.js';
import { Coordination } from '../coordination/service.js';
import { assertFound, GatewayError } from '../core/errors.js';
import { gatewayTimeZone } from '../core/time-zone.js';
import type { Decisions, Question } from '../decisions/service.js';
import type { Outreach } from '../errands/port.js';
import { X_TOOL_GROUPS } from '../integrations/x/catalog/index.js';
import { sameSubject } from '../memories/duplicates.js';
import type { MemoryWriter } from '../memories/port.js';
import type { PeerAgents } from '../peers/port.js';
import type { ProfileAdmin } from '../profiles/port.js';
import type { Remote } from '../remote/service.js';
import type { RunExecution, RunReader } from '../runs/port.js';
import { recordedToolResult } from '../runs/repository.js';
import type { Schedules } from '../schedules/service.js';
import { isLoaded, useLoads } from '../sessions/loads.js';
import type { SessionNamer, SessionReader, SessionSummarizer } from '../sessions/port.js';
import type { Sessions } from '../sessions/service.js';
import { findSkill } from '../skills/builtin/index.js';
import { longRunningWork, longRunningWorkFor } from '../skills/builtin/long-running-work.js';
import { managingContext, managingContextFor } from '../skills/builtin/managing-context.js';
import { ownerAndContacts, ownerAndContactsFor } from '../skills/builtin/owner-and-contacts.js';
import { remoteControl, remoteControlFor } from '../skills/builtin/remote-control.js';
import { type WebAccess, webResearch, webResearchFor } from '../skills/builtin/web-research.js';
import { worktreesFor, worktrees as worktreesSkill } from '../skills/builtin/worktrees.js';
import { x, xFor } from '../skills/builtin/x.js';
import { skillTools } from '../skills/tools.js';
import type { SshKeys } from '../ssh/service.js';
import type { Stats } from '../stats/service.js';
import type { Store } from '../storage/database.js';
import { artifacts, checkpoints } from '../storage/schema.js';
import type { Work } from '../tasks/service.js';
import { AskUserPause } from './ask-user.js';
import { type FileBackend, fileTools } from './files.js';
import { remoteTools } from './remote-tools.js';
import { artifactPage } from './results.js';
import { shellTools } from './shell.js';

/** What the tool set reaches for on the profile's behalf during a run. */
const jevQuestionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('noul'),
    instructions: z.string().trim().min(1).max(2_000),
    criteria: z.object({ yes: z.string().min(1).max(600), no: z.string().min(1).max(600) }),
  }),
  z.object({
    type: z.literal('choice'),
    instructions: z.string().trim().min(1).max(2_000),
    criteria: z
      .object({})
      .catchall(z.string().max(600).nullable())
      .refine(
        (criteria) =>
          Object.keys(criteria).length >= 2 &&
          Object.keys(criteria).length <= 20 &&
          Object.keys(criteria).every((key) => key.length >= 1 && key.length <= 100),
        'choice needs between two and twenty alternatives with keys of at most 100 characters',
      ),
  }),
  z.object({
    type: z.literal('score'),
    instructions: z.string().trim().min(1).max(2_000),
    criteria: z.array(z.string().min(1).max(600)).min(2).max(20),
  }),
]);

const jevInputSchema = z.object({
  use: decisionUseSchema,
  state: z
    .object({})
    .catchall(z.unknown())
    .refine(
      (state) =>
        Object.keys(state).every((key) => key.length <= 100) &&
        JSON.stringify(state).length <= 24_000,
      'state keys must be at most 100 characters and the state must fit within 24000 characters',
    ),
  question: jevQuestionSchema,
});

export type ToolServices = {
  profiles: ProfileAdmin;
  memories: MemoryWriter;
  sessions: SessionReader &
    SessionNamer &
    SessionSummarizer &
    Partial<Pick<Sessions, 'setObjective' | 'writeObjective' | 'react'>>;
  runs: RunReader;
  peers: PeerAgents;
  lifecycle: RunExecution;
  errands: Outreach;
  store: Store;
  decisions?: Pick<Decisions, 'ask' | 'judge'>;
  schedules?: Pick<Schedules, 'list' | 'create' | 'update' | 'remove'>;
  settings?: { timeZone(): Promise<string> };
  stats?: Pick<Stats, 'stats' | 'usageRuns'>;
  work?: Pick<
    Work,
    'spawnInConversation' | 'awaitReport' | 'cancelInConversation' | 'focusInspector'
  >;
  sshKeys: Pick<SshKeys, 'list' | 'create' | 'remove' | 'sync'>;
  remote?: Pick<
    Remote,
    'list' | 'execute' | 'executeComputer' | 'update' | 'executeFiles' | 'offersFiles'
  >;
};

/**
 * A tool whose call waits for the owner even where actions run on their own: Auto, or a subagent.
 * True for this input means the owner decides; only Full access runs it without them.
 */
export type OwnerGate = { asksOwner: (input: unknown) => Promise<boolean> };

export const asksOwner = (definition: unknown, input: unknown): Promise<boolean> =>
  (definition as Partial<OwnerGate>).asksOwner?.(input) ?? Promise.resolve(false);

/**
 * A skill as this run may load it: the owner's own of that name as they wrote it, and the two
 * built-in ones that say only what the run can do, written for this run.
 */
export function skillFor(
  run: Run,
  servers: readonly McpServer[],
  name: string,
  can: {
    web: WebAccess;
    xConnected: boolean;
    /** What the run has of the worktree tools; absent when it has none. */
    worktrees?: { create: boolean; machine: boolean; signals: boolean; files?: boolean };
    /** The conversation targets a machine, and whether this run's file tools work on it. */
    machine?: { files: boolean };
    /** The run has `send_email`. */
    email?: boolean;
  },
  /** The skills of the conversation's workspaces, named apart from the profile's already. */
  projectSkills: readonly Skill[] = [],
): Skill | undefined {
  const skill =
    findSkill(run.profile, servers, name, { worktrees: Boolean(can.worktrees) }) ??
    projectSkills.find((item) => item.name === name);
  if (skill === webResearch) return webResearchFor(can.web);
  if (skill === x) return xFor({ connected: can.xConnected, subagent: Boolean(run.subagent) });
  if (skill === worktreesSkill && can.worktrees) {
    return worktreesFor({ ...can.worktrees, subagent: Boolean(run.subagent) });
  }
  if (skill === managingContext) return managingContextFor({ subagent: Boolean(run.subagent) });
  if (skill === longRunningWork) {
    return longRunningWorkFor({
      create: Boolean(can.worktrees?.create),
      machine: Boolean(can.machine ?? can.worktrees?.machine),
      subagent: Boolean(run.subagent),
    });
  }
  if (skill === remoteControl) return remoteControlFor(can.machine);
  if (skill === ownerAndContacts) return ownerAndContactsFor(Boolean(can.email));
  return skill;
}

export function profileTools(
  services: ToolServices,
  run: Run,
  gitAccess: { readOnly: string[]; writable: string[] } = { readOnly: [], writable: [] },
  remoteTarget?: string,
  /** The MCP servers the run reaches; the skills it may load follow them. */
  servers: readonly McpServer[] = [],
  /** What it can do with web pages, which the skill about them and the Inspector go by. */
  web: WebAccess = { browser: false, inspects: true, subagent: Boolean(run.subagent) },
  /** Whether this run has X's tools, which the skill about them goes by. */
  xConnected = false,
  /** The skills the conversation's workspaces offer. */
  projectSkills: readonly Skill[] = [],
  /** Whether this run has the worktree tools, which the skill about them goes by. */
  worktrees?: { create: boolean; machine: boolean; signals: boolean; files?: boolean },
  /** The file tools' reach on the machine this run targets, when it offers them there. */
  machineFiles?: FileBackend,
  /**
   * The run's scale now (`context/scale.ts`): a page of read_artifact is sized as the runtime
   * bounds its result, or a page sized in other units would be cut again.
   */
  scale?: () => number,
  /** Whether the profile has a live email channel this run may write from (`send_email`). */
  email = false,
): ToolSet {
  const coordination = new Coordination(services);
  const rechecked = new Set<string>();

  const tools: ToolSet = {
    react_to_message: tool({
      description:
        'React naturally to a person’s message with one emoji when it fits the conversation. Be selective; do not react to every message. Omit messageId for the latest user message in this conversation, or use read_session to find an older message ID. Null removes your reaction. Works in Jian, WhatsApp and Telegram; channel reactions are queued for native delivery.',
      inputSchema: messageReactionInputSchema.extend({ messageId: z.uuid().optional() }),
      execute: async ({ messageId, emoji }) => {
        if (!services.sessions.react)
          throw new GatewayError(409, 'Message reactions are unavailable');
        const id =
          messageId ??
          (await services.sessions.messages(run.profileId, run.sessionId, 50)).findLast(
            (message) => message.role === 'user' && message.purpose !== 'resume',
          )?.id;
        if (!id) throw new GatewayError(404, 'No user message to react to');
        const result = await services.sessions.react(
          run.profileId,
          run.sessionId,
          id,
          { emoji },
          'agent',
          run.id,
        );
        return { messageId: result.id, reactions: result.reactions ?? [] };
      },
    }),
    list_ssh_keys: tool({
      description:
        'List the installation’s SSH keys, shared by every agent. Returns names, public keys and fingerprints only; private keys are never returned.',
      inputSchema: z.object({}),
      execute: async () => services.sshKeys.list(),
    }),

    create_ssh_key: tool({
      description:
        'Create an Ed25519 SSH key through Jian, shared by every agent of the installation. Git can use it from your next run. Never use ssh-keygen or create SSH keys through the shell.',
      inputSchema: z.object({ name: z.string().trim().min(1).max(80) }),
      execute: async ({ name }) => services.sshKeys.create({ name }),
    }),

    delete_ssh_key: tool({
      description:
        'Delete one of the installation’s SSH keys, for every agent. List the keys first and use the returned id.',
      inputSchema: z.object({ id: z.uuid() }),
      execute: async ({ id }) => services.sshKeys.remove(id),
    }),

    list_activities: tool({
      description:
        'Read the actual queued, running, and waiting tasks across this profile’s sessions.',
      inputSchema: z.object({}),
      execute: async () =>
        (await services.runs.activities(run.profileId)).map((r) => ({
          id: r.id,
          sessionId: r.sessionId,
          status: r.status,
          input: r.input.slice(0, 500),
          updatedAt: r.updatedAt,
          ...(r.question ? { question: r.question } : {}),
        })),
    }),

    // Nothing happens on the gateway: the panel showing this conversation sees the call arrive
    // and throws the confetti itself. A WhatsApp or Telegram chat has no screen to throw it on.
    throw_confetti: tool({
      description:
        'Throw confetti on the owner’s screen in Jian, for a real celebration (a launch, a milestone, a birthday) or when asked.',
      inputSchema: z.object({}),
      execute: async () => {
        if (run.subagent) return { thrown: false, reason: 'A subagent’s work is not on screen.' };
        const { channel } = await services.sessions.session(run.profileId, run.sessionId);
        if (isChatChannel(channel)) {
          return {
            thrown: false,
            reason: `This conversation is on ${channel}, where confetti cannot be shown. Celebrate in words.`,
          };
        }
        return { thrown: true };
      },
    }),

    set_session_objective: tool({
      description:
        'Set or replace the durable objective for this conversation. Pass a short durable goal (what to achieve) — never shell output, logs, stack traces, or tool dumps. The gateway re-injects this text on every auto-continue. Use when the owner asks for multi-step work and no open objective fits, or when the goal clearly changed.',
      inputSchema: z.object({
        text: z.string().trim().min(1).max(MAX_OBJECTIVE_TEXT),
      }),
      execute: async ({ text }) => {
        if (!services.sessions.setObjective) {
          throw new GatewayError(500, 'Session objectives are unavailable');
        }
        const session = await services.sessions.setObjective(run.profileId, run.sessionId, {
          text,
          status: 'open',
        });
        return session.objective;
      },
    }),

    complete_session_objective: tool({
      description:
        'Mark the session objective done. Call only when the objective is fully satisfied — not after a partial slice.',
      inputSchema: z.object({
        note: z.string().trim().min(1).max(500).optional(),
      }),
      execute: async ({ note }) => {
        if (!services.sessions.setObjective) {
          throw new GatewayError(500, 'Session objectives are unavailable');
        }
        const current = await services.sessions.session(run.profileId, run.sessionId);
        if (!current.objective?.text)
          throw new GatewayError(400, 'No session objective to complete');
        const session = await services.sessions.setObjective(run.profileId, run.sessionId, {
          text: current.objective.text,
          status: 'done',
          ...(note ? { note } : {}),
        });
        return session.objective;
      },
    }),

    block_session_objective: tool({
      description:
        'Pause the open objective because you need the owner’s input. The gateway will not auto-continue until they reply.',
      inputSchema: z.object({
        note: z.string().trim().min(1).max(500),
      }),
      execute: async ({ note }) => {
        if (!services.sessions.setObjective) {
          throw new GatewayError(500, 'Session objectives are unavailable');
        }
        const current = await services.sessions.session(run.profileId, run.sessionId);
        if (!current.objective?.text) throw new GatewayError(400, 'No session objective to block');
        const session = await services.sessions.setObjective(run.profileId, run.sessionId, {
          text: current.objective.text,
          status: 'blocked',
          note,
        });
        return session.objective;
      },
    }),

    cancel_session_objective: tool({
      description: 'Cancel the session objective when the owner abandons the work.',
      inputSchema: z.object({
        note: z.string().trim().min(1).max(500).optional(),
      }),
      execute: async ({ note }) => {
        if (!services.sessions.setObjective) {
          throw new GatewayError(500, 'Session objectives are unavailable');
        }
        const current = await services.sessions.session(run.profileId, run.sessionId);
        if (!current.objective?.text) throw new GatewayError(400, 'No session objective to cancel');
        const session = await services.sessions.setObjective(run.profileId, run.sessionId, {
          text: current.objective.text,
          status: 'cancelled',
          ...(note ? { note } : {}),
        });
        return session.objective;
      },
    }),

    ...(!run.subagent
      ? {
          ask_user: tool({
            description:
              'Ask the owner a required question and pause this run until they answer. Prefer this over finishing the turn or block_session_objective when you need a concrete choice or fact to continue. Optional choices become a list in the panel and a reply keyboard on Telegram. In a WhatsApp or Telegram conversation it still asks the owner, in the panel, not the person you are talking with (unless the owner allowed that chat to approve), and needs choices; to ask that person something, write it in your reply instead. When you have a view on which choice is best, set recommended to that choice, copied exactly; leave it out when you have none.',
            inputSchema: z.object({
              prompt: z.string().trim().min(1).max(2000),
              choices: z.array(z.string().trim().min(1).max(100)).min(2).max(12).optional(),
              recommended: z.string().trim().min(1).max(100).optional(),
            }),
            execute: async ({
              prompt,
              choices,
              recommended,
            }: {
              prompt: string;
              choices?: string[];
              recommended?: string;
            }): Promise<{ paused: false; reason: string }> => {
              // In a chat or an email conversation the owner answers from the card in the panel,
              // which has no text field: a question without choices there could never be answered.
              if (!choices?.length) {
                const { channel } = await services.sessions.session(run.profileId, run.sessionId);
                if (isChatChannel(channel) || channel === 'email') {
                  return {
                    paused: false,
                    reason: `This conversation is on ${channel}: the owner answers from the panel by picking a choice. Ask again with choices.`,
                  };
                }
              }
              throw new AskUserPause({
                prompt,
                ...(choices?.length ? { choices } : {}),
                ...(recommended ? { recommended } : {}),
              });
            },
          }),
        }
      : {}),

    ...(services.work && !run.subagent
      ? {
          cancel_subagent: tool({
            description:
              'Stop a subagent in this conversation when its work is unnecessary or the owner asks. Use the runId returned by spawn_subagent. Completed work is retained; already finished runs stay finished.',
            inputSchema: z.strictObject({ runId: z.uuid() }),
            execute: async ({ runId }) => services.work?.cancelInConversation(run, runId),
          }),
          open_in_inspector: tool({
            description: `Bring something to the owner's Inspector, the panel beside this conversation, and focus its tab: a GitHub pull request or issue, or one of this conversation's subagents${web.browser ? ', or the browser' : ''}. Do it when they ask, or when watching it would help them, as when you start a subagent they care about or open a pull request for them to review. It shows nothing if they are looking at another conversation.`,
            inputSchema: inspectorFocusInputSchema,
            execute: async (input) => {
              // Nothing would happen in the panel, and the owner would be told otherwise.
              if (input.kind === 'browser' && !web.browser) {
                throw new GatewayError(409, 'This conversation has no browser beside it.');
              }
              return services.work?.focusInspector(run, input);
            },
          }),
          spawn_subagent: tool({
            description: `Hand an assignment to a subagent: a fresh agent with its own context, which reports back. Worth it for work whose intermediate output is not worth keeping here (a wide search, long logs, a test run, many files), independent pieces (calls in one step run in parallel) and a fresh-eyes review; not for a single lookup or a few files. The brief is all it knows: the objective, context, paths and the result you need; pass media IDs for needed images. ${
              remoteTarget
                ? "It works on the gateway, not on this conversation's machine: its file tools and run_command are the gateway's, and it reaches the machine only through run_remote_command, so name the machine, the paths and the cwd in the brief."
                : 'It works on the same files as you.'
            } The call waits and returns its report, for up to 15 minutes, after which the report arrives here later; wait false returns at once. Leave tier out to let Decisions pick light, standard or deep.`,
            inputSchema: conversationSubagentInputSchema,
            execute: async (input, options) => {
              const work = services.work;
              if (!work) throw new GatewayError(409, 'Subagents are unavailable');
              // Parsed again: a call the model made arrives with its defaults, one replayed after
              // an approval or from a test without them, and `wait` must mean the same in both.
              const { wait } = conversationSubagentInputSchema.parse(input);
              const child = await work.spawnInConversation(run, input, options.toolCallId, wait);
              // The brief is the agent's own words: echoing it back would only cost its context.
              const { input: _brief, sessionId: _session, ...started } = child;
              if (!wait) {
                return {
                  ...started,
                  note: 'Its report will arrive in this conversation when it finishes.',
                };
              }
              return work.awaitReport(run, child.runId, options.abortSignal);
            },
          }),
        }
      : {}),

    ...(services.stats
      ? {
          read_activity_stats: tool({
            description:
              'Read your own complete activity and token usage for a period: totals, estimated cost, models, channels and tools. Includes the shared Codex/Claude subscription windows when available; unavailable is not zero remaining. Subscription tokens are not money spent.',
            inputSchema: z.object({ days: z.number().int().min(1).max(3660).default(30) }),
            execute: async ({ days }) => services.stats?.stats(run.profileId, { days }, true),
          }),
          read_usage_runs: tool({
            description:
              'Page through your own individual runs, with model, channel, duration, fresh/cached/output tokens and estimated metered cost in USD. No message text or secrets are returned.',
            inputSchema: z.object({
              days: z.number().int().min(1).max(3660).default(30),
              limit: z.number().int().min(1).max(50).default(25),
              offset: z.number().int().min(0).default(0),
            }),
            execute: async ({ days, limit, offset }) =>
              services.stats?.usageRuns(run.profileId, days, limit, offset),
          }),
        }
      : {}),

    read_memories: tool({
      description:
        'Find shared memories, with their versions and what each is linked to. Give a few words of the subject to search; with none, the most recent. Search before remember, and update the memory you find instead of writing a near-duplicate.',
      inputSchema: z.object({ query: z.string().max(200).optional() }),
      execute: async ({ query }) => services.memories.search(run.profileId, query ?? ''),
    }),

    remember: tool({
      description:
        'Save a fact or decision shared by all sessions of this profile. Use expectedVersion=0 for a new key, or the current version for an update.',
      inputSchema: memorySchema,
      execute: async (input) => {
        // Checked once per key and turn: an agent told of a near-duplicate that saves again
        // under the same key has read the other memory and decided they differ.
        if (input.expectedVersion === 0 && services.decisions && !rechecked.has(input.key)) {
          rechecked.add(input.key);

          const existing = await sameSubject(
            services.decisions.judge,
            services.memories,
            run.profileId,
            input,
          );

          if (existing) {
            return {
              held: `Not saved: the memory ${JSON.stringify(existing.key)} (version ${existing.version}) looks like the same subject. Update it with that key and version instead. If the two are truly different, call remember again with the same key to save this one.`,
              existing: { key: existing.key, version: existing.version, content: existing.content },
            };
          }
        }

        return services.memories.remember(run.profileId, input, run.sessionId);
      },
    }),

    ...(services.schedules
      ? scheduleTools(services.schedules, run, () =>
          services.settings ? services.settings.timeZone() : Promise.resolve(gatewayTimeZone()),
        )
      : {}),

    forget_memory: tool({
      description:
        'Delete one of your memories, and its links, when it is wrong, superseded, or merged into another. It cannot be undone.',
      inputSchema: z.object({ key: memoryKeySchema }),
      execute: async ({ key }) => services.memories.forget(run.profileId, key),
    }),

    link_memories: tool({
      description:
        'Link two memories about the same subject, or worth recalling together: whenever one is relevant to a request, the other is recalled with it. Links go both ways.',
      inputSchema: z.object({ key: memoryKeySchema, with: memoryKeySchema }),
      execute: async (input) => services.memories.link(run.profileId, input.key, input.with),
    }),

    unlink_memories: tool({
      description: 'Undo a link between two memories that no longer belong together.',
      inputSchema: z.object({ key: memoryKeySchema, from: memoryKeySchema }),
      execute: async (input) => services.memories.unlink(run.profileId, input.key, input.from),
    }),

    list_sessions: tool({
      description: 'Find other conversations belonging to this profile.',
      inputSchema: z.object({}),
      // The newest hundred: the whole list would crowd out the conversation it is read into.
      execute: async () => (await services.sessions.sessions(run.profileId)).slice(0, 100),
    }),

    read_session: tool({
      description: 'Read recent messages in one of this profile’s sessions.',
      inputSchema: z.object({ sessionId: z.string().uuid() }),
      execute: async ({ sessionId }) =>
        (await services.sessions.messages(run.profileId, sessionId, 20)).map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content.slice(0, 2000),
          createdAt: m.createdAt,
        })),
    }),

    load_skill: tool({
      description:
        'Load instructions for a skill enabled on this profile. A skill loaded once stays in your instructions for the rest of the conversation: never load one the catalog marks loaded.',
      inputSchema: z.object({ name: z.string() }),
      execute: async ({ name }) => {
        const skill = skillFor(
          run,
          servers,
          name,
          {
            web,
            xConnected,
            worktrees,
            email,
            ...(remoteTarget ? { machine: { files: Boolean(machineFiles) } } : {}),
          },
          projectSkills,
        );

        if (!skill) {
          throw new GatewayError(404, 'Skill not found');
        }

        // Kept per conversation: a subagent's is its own, and starts with nothing loaded. What
        // goes wrong keeping it costs the keeping: the skill is still answered with.
        const scope = { profileId: run.profileId, sessionId: run.sessionId };
        const kept = await isLoaded(services.store.db, scope, 'skill', skill.name).catch(
          () => false,
        );
        await useLoads(services.store.db, scope, 'skill', [skill.name], new Date()).catch(
          () => undefined,
        );
        if (kept) {
          return {
            name: skill.name,
            loaded: true,
            note: 'Already loaded in this conversation: its instructions are under Loaded skills in your instructions, or above in this turn if you loaded it just now. Follow them; there is nothing to load.',
          };
        }
        return skill;
      },
    }),

    ask_jev: tool({
      description:
        'Ask Jev for one narrow semantic judgment. It returns a probability, choice or score as a second opinion; unavailable means use the fixed rule.',
      inputSchema: jevInputSchema,
      execute: async ({ use, state, question }) => {
        if (!services.decisions) {
          return { available: false, reason: 'Jev is not configured in this gateway.' };
        }

        const normalized: Question =
          question.type === 'noul'
            ? {
                ...question,
                criteria: { true: question.criteria.yes, false: question.criteria.no },
              }
            : question;
        const answers = await services.decisions.judge(state, { judgment: normalized }, { use });
        const answer = answers?.judgment;

        return answer ? { available: true, answer } : { available: false };
      },
    }),

    search_history: tool({
      description: 'Search paginated conversation history for this profile.',
      inputSchema: z.object({
        sessionId: z.string().uuid().optional(),
        before: z.string().min(1).max(200).optional(),
        limit: z.number().int().min(1).max(20).default(10),
        q: z.string().trim().min(1).max(200).optional(),
      }),
      execute: async ({ sessionId, ...query }) => {
        const page = await coordination.history(run.profileId, sessionId, query);

        // Where another agent answered is the panel's to show; to this agent it is the other
        // side of the wall, so its ids never reach the model.
        return { ...page, items: page.items.map(({ call: _call, ...message }) => message) };
      },
    }),

    read_artifact: tool({
      description:
        'Read a full tool result one page at a time: a stored one by its artifactId, or one of an earlier turn of this conversation by its toolCallId, when the history shows it cut. Follow nextOffset until null; do not review a diff or claim complete coverage from a preview alone. Offsets count UTF-16 code units.',
      inputSchema: z.object({
        artifactId: z.string().uuid().optional(),
        toolCallId: z.string().min(1).max(200).optional(),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(16000).default(16000),
      }),
      execute: async ({ artifactId, toolCallId, offset, limit }) => {
        if (!artifactId === !toolCallId) {
          throw new GatewayError(400, 'Name either an artifactId or a toolCallId.');
        }
        if (toolCallId) {
          const recorded = await recordedToolResult(
            services.store.db,
            run.profileId,
            run.sessionId,
            toolCallId,
          );
          if (recorded === undefined) throw new GatewayError(404, 'Tool call not found');
          const content =
            typeof recorded === 'string' ? recorded : (JSON.stringify(recorded, null, 2) ?? '');
          return { toolCallId, ...artifactPage(content, offset, limit, run, undefined, scale?.()) };
        }
        // The profile in the where clause is the owner check: another profile's artifact is
        // not found rather than read, whatever id the model guesses.
        const [record] = await services.store.db
          .select({ content: artifacts.content })
          .from(artifacts)
          .where(
            and(eq(artifacts.id, artifactId as string), eq(artifacts.profileId, run.profileId)),
          )
          .limit(1);

        const { content } = assertFound(record, 'Artifact');
        return artifactPage(content, offset, limit, run, artifactId, scale?.());
      },
    }),

    read_run_checkpoints: tool({
      description:
        'Inspect saved results before continuing a run; unknown external effects require reconciliation.',
      inputSchema: z.object({ runId: z.string().uuid() }),
      execute: async ({ runId }) => {
        // Reading the run first is the owner check: a run of another profile is not found, so
        // its checkpoints are never selected.
        await services.runs.run(run.profileId, runId);

        const saved = await services.store.db
          .select({
            id: checkpoints.id,
            data: checkpoints.data,
            createdAt: checkpoints.createdAt,
          })
          .from(checkpoints)
          .where(and(eq(checkpoints.profileId, run.profileId), eq(checkpoints.runId, runId)))
          .orderBy(desc(checkpoints.createdAt))
          .limit(100);

        return saved.map((checkpoint) => {
          const data =
            checkpoint.data && typeof checkpoint.data === 'object'
              ? (checkpoint.data as Record<string, unknown>)
              : {};

          return {
            id: checkpoint.id,
            createdAt: checkpoint.createdAt.toISOString(),
            phase: data.phase,
            toolName: data.toolName,
            toolCallId: data.toolCallId,
            finishReason: data.finishReason,
            usage: data.usage,
            tools: Array.isArray(data.tools)
              ? data.tools.map((item: unknown) => {
                  const tool = item as Record<string, unknown>;

                  return {
                    toolName: tool.toolName,
                    toolCallId: tool.toolCallId,
                    artifactId: tool.artifactId,
                    bytes: tool.bytes,
                    result: tool.result,
                  };
                })
              : undefined,
          };
        });
      },
    }),

    send_session_message: tool({
      description:
        'Write text into another of your conversations. A WhatsApp, Telegram or email conversation — a person or an approved group — receives it on that channel, as a message from you; any other session gets it in its inbox. Text only: to send a file, an image or a voice note there, use send_file, generate_image or generate_speech with its sessionId. Idempotent by requestKey.',
      inputSchema: z.object({
        toSessionId: z.string().uuid(),
        text: z.string().trim().min(1).max(4000),
        requestKey: z.string().min(1).max(120),
      }),
      execute: async (input) => {
        // A channel conversation is a person on a phone: an inbox there is read by nobody, and
        // reporting it as sent is how an agent came to promise messages that never left.
        const sent = await services.errands.write(
          run.profileId,
          input.toSessionId,
          run.id,
          input.text,
          input.requestKey,
        );

        if (sent) {
          return { delivered: 'queued on the channel', ...sent };
        }

        return {
          delivered: 'inbox only — this session has no channel',
          ...(await coordination.send(run.profileId, { ...input, fromSessionId: run.sessionId })),
        };
      },
    }),

    list_contacts: tool({
      description:
        'The people this profile may write to on its channels: their id, name and where they are reached. Approved by the owner, never by you.',
      inputSchema: z.object({}),
      execute: async () => services.errands.reachable(run.profileId),
    }),

    message_contact: tool({
      description:
        'Write to one of this profile’s approved contacts on their own channel. With expectReply, their answer comes back to this conversation instead of theirs — say so to whoever asked, because it will not arrive in this turn.',
      inputSchema: z.object({
        contactId: z.string().uuid(),
        text: z.string().trim().min(1),
        expectReply: z.boolean().default(false),
      }),
      execute: async ({ contactId, text, expectReply }) =>
        services.errands.ask(run.profileId, contactId, run.sessionId, run.id, text, expectReply),
    }),

    // The owner reads the first email to anyone but an approved contact before it leaves,
    // whatever this conversation's protection short of Full access: see `asksOwner` below.
    send_email: tool({
      description:
        'Send an email from this agent’s own address to any address, such as a company’s support. The first email to an address that is not an approved contact waits for the owner to approve it; later emails to it from this conversation go without asking while its replies still come back here. Without a subject it continues your latest thread with that address. With expectReply, every reply in the next 7 days comes back to this conversation, an automatic acknowledgement included, not in this turn: say so to whoever asked.',
      inputSchema: z.object({
        to: z.string().trim().min(3).max(100),
        subject: z
          .string()
          .trim()
          .min(1)
          .max(200)
          .optional()
          .describe('Starts a new thread. Required for the first email to an address.'),
        // Short enough that the owner's approval card shows all of it.
        text: z.string().trim().min(1).max(3500),
        expectReply: z.boolean().default(true),
        requestKey: z.string().min(1).max(120).optional(),
      }),
      execute: async ({ requestKey, ...request }, { toolCallId }) =>
        services.errands.email(
          run.profileId,
          run.sessionId,
          run.id,
          request,
          requestKey ?? toolCallId,
        ),
    }),

    read_inbox: tool({
      description: 'Read messages sent to this session.',
      inputSchema: z.object({}),
      execute: async () => coordination.inbox(run.profileId, run.sessionId),
    }),

    acquire_resource: tool({
      description:
        'Acquire or renew a profile resource lease before exclusive work. Keep its fence.',
      inputSchema: z.object({
        resource: z.string().regex(/^[a-zA-Z0-9_./:-]{1,200}$/),
        ttlSeconds: z.number().int().min(5).max(300).default(60),
      }),
      execute: async (input) =>
        coordination.acquire(run.profileId, { ...input, sessionId: run.sessionId }),
    }),

    release_resource: tool({
      description: 'Release only this session’s current resource lease using its fence.',
      inputSchema: z.object({
        resource: z.string().regex(/^[a-zA-Z0-9_./:-]{1,200}$/),
        fence: z.number().int().positive(),
      }),
      execute: async (input) =>
        coordination.release(run.profileId, { ...input, sessionId: run.sessionId }),
    }),
  };

  // Read by the runtime before the call, as it reads where an action lands (`asksOwner`).
  if (email)
    Object.assign(tools.send_email as object, {
      asksOwner: (input: unknown) =>
        services.errands.needsOwner(
          run.profileId,
          run.sessionId,
          String((input as { to?: unknown } | null)?.to ?? ''),
        ),
    } satisfies OwnerGate);
  else delete tools.send_email;

  Object.assign(tools, {
    list_agents: tool({
      description:
        'List the other agents of this installation: their id, name and what each one does. Their instructions, memories and conversations are not readable — here or anywhere else.',
      inputSchema: z.object({}),
      execute: async () => services.peers.agents(run.profileId),
    }),

    ask_agent: tool({
      description:
        'Ask another agent of this installation and wait for its written answer. Only text crosses: they never read your memories, sessions or history, and you never read theirs. The two of you keep one shared thread. A chain of calls is bounded — you cannot ask yourself, nor an agent that already spoke in this conversation, and the depth budget is shared by everyone in the chain.',
      inputSchema: agentCallSchema,
      execute: async (input, { abortSignal }) => services.peers.ask(run, input, abortSignal),
    }),
  });

  // The shell and the file tools are always available, and so is every connected
  // machine; a conversation aimed at one machine works there instead of locally: its commands
  // through run_remote_command, its files through the same file tools when its worker has them.
  if (!remoteTarget) Object.assign(tools, shellTools(gitAccess));
  else if (machineFiles) Object.assign(tools, fileTools(machineFiles));
  if (services.remote) {
    Object.assign(tools, remoteTools(run, services.remote, services.store, remoteTarget));
  }

  // Writing its own skills is part of every agent's work, not of managing itself: what it
  // writes is marked as its own, shown to the owner under Skills, and only it can change it.
  Object.assign(tools, skillTools(services.profiles, run));

  tools.update_identity = tool({
    description:
      'Version an update to your own identity. Applies to new runs. Cannot change permissions, keys or providers.',
    inputSchema: z.object({
      expectedVersion: z.number().int().positive(),
      name: z.string().min(1).max(100).optional(),
      instructions: z.string().min(1).max(8000).optional(),
      identity: z
        .object({
          role: z.string().max(1000),
          tone: z.string().max(1000),
          goals: z.array(z.string().max(500)).max(10),
          boundaries: z.array(z.string().max(500)).max(10),
        })
        .optional(),
    }),
    execute: async (input) => {
      const updated = await services.profiles.updateProfile(run.profileId, input);

      return { id: updated.id, name: updated.name, version: updated.version };
    },
  });

  tools.read_identity = tool({
    description: 'Read the latest version of your identity before editing it.',
    inputSchema: z.object({}),
    execute: async () => {
      const p = await services.profiles.profile(run.profileId);

      return {
        id: p.id,
        name: p.name,
        instructions: p.instructions,
        identity: p.identity,
        version: p.version,
      };
    },
  });

  tools.create_profile = tool({
    description:
      'Create a separate profile without provider access. An administrator must configure its provider key before it can run.',
    inputSchema: z.object({
      name: z.string().min(1).max(100),
      instructions: z.string().min(1).max(8000),
    }),
    execute: async (input) => {
      const { apiKeyEnv: _env, providerId: _provider, ...model } = run.profile.model;
      const created = await services.profiles.createProfile({ ...input, model });

      return { id: created.id, name: created.name };
    },
  });

  return tools;
}

/**
 * Tools the agent asks for when it needs them. Every definition costs its description and its
 * schema on *every* model call of the run, so a set that is always complete is paid for by
 * turns that use none of it — measured at 8.5 KB of prompt for a greeting. What is left in
 * `core` is what a turn is likely to need before it has had a chance to ask for anything:
 * memory, skills, what the profile is doing, and the other agents, so a conversation between
 * profiles still costs one call rather than two.
 */
export const TOOL_GROUPS = {
  activity: {
    summary:
      'read your own full activity, tokens and estimated cost by day, model, channel, tool and individual run',
    tools: ['read_activity_stats', 'read_usage_runs'],
  },
  schedules: {
    summary:
      'do something later or on a repetition — reminders, daily summaries, recurring checks — and list, change, pause (switch off without deleting), resume or delete them',
    tools: ['list_schedules', 'create_schedule', 'update_schedule', 'delete_schedule'],
  },
  skills: {
    summary:
      'write, rewrite and remove your own skills: routines you follow the same way each time',
    tools: ['create_skill', 'update_skill', 'delete_skill'],
  },
  memory: {
    summary: 'tidy your memories: delete one, and link or unlink those recalled together',
    tools: ['forget_memory', 'link_memories', 'unlink_memories'],
  },
  media: {
    summary:
      'open attachments, save them, send files and documents into any conversation, generate images, and reply with voice',
    tools: [
      'analyze_media',
      'send_file',
      'save_attachment',
      'generate_image',
      'list_speech_voices',
      'generate_speech',
    ],
  },
  files: {
    summary:
      'read, edit, write, find and search files on the machine this gateway runs on — for code too',
    tools: ['read_file', 'edit_file', 'write_file', 'find_files', 'search_files', 'list_directory'],
  },
  shell: {
    summary: 'run commands on the machine this gateway runs on',
    tools: ['run_command'],
  },
  remote: {
    summary:
      'list the connected machines, run commands there, drive the Mac screen (remote_computer), pull or push files, and update their Jian Remote',
    tools: [
      'list_remote_machines',
      'run_remote_command',
      'remote_computer',
      'pull_remote_file',
      'push_remote_file',
      'update_remote_machine',
    ],
  },
  web: {
    summary:
      'search the web and read pages; where this conversation allows, inspect website designs and interactions with screenshots, DOM, styles and assets, and use the browser the owner watches',
    tools: ['web_search', 'fetch_url', 'inspect_page', 'browser_control'],
  },
  conversations: {
    summary:
      'list your other conversations, read one, search by words across all of them (what was agreed elsewhere, who asked for what), write into one, and read your inbox',
    tools: [
      'list_sessions',
      'read_session',
      'search_history',
      'send_session_message',
      'read_inbox',
    ],
  },
  tasks: {
    summary:
      "show a subagent, pull request or issue in the owner's Inspector, inspect checkpoints and stored output, manage resource leases, or compact context",
    tools: [
      'open_in_inspector',
      'read_run_checkpoints',
      'read_artifact',
      'acquire_resource',
      'release_resource',
      'compact_context',
    ],
  },
  contacts: {
    summary:
      'list the people the owner approved on your channels and write to one, optionally bringing their answer back here',
    tools: ['list_contacts', 'message_contact', 'send_email'],
  },
  self: {
    summary: 'read and version your own identity, and create profiles',
    tools: ['read_identity', 'update_identity', 'create_profile'],
  },
  ...X_TOOL_GROUPS,
} as const;

export type ToolGroup = keyof typeof TOOL_GROUPS;

/** The `contacts` group for a run that has `send_email`. */
export const CONTACTS_WITH_EMAIL_SUMMARY =
  'list the people the owner approved on your channels and write to one, or email any address once the owner approves that email, optionally bringing the answers back here';

/** The `files` group for a run whose file tools reach its machine, not the gateway's. */
export const MACHINE_FILES_SUMMARY =
  'read, edit, write, find and search files on the machine this conversation works on — for code too';

const deferred = new Map<string, ToolGroup>(
  Object.entries(TOOL_GROUPS).flatMap(([group, entry]) =>
    entry.tools.map((name) => [name, group as ToolGroup] as const),
  ),
);

/**
 * A tool's group mates this run has. Loaded tools last one run, and the turn that carries on after
 * an approval is a new one: without this, the group it was working from would go out of reach.
 */
export function groupMates(name: string, tools: ToolSet): string[] {
  const group = deferred.get(name);
  return group ? TOOL_GROUPS[group].tools.filter((mate) => mate in tools) : [];
}

/** The groups this run can actually offer: a group whose tools are all absent is not one. */
function offeredGroups(tools: ToolSet): ToolGroup[] {
  return (Object.keys(TOOL_GROUPS) as ToolGroup[]).filter((group) =>
    TOOL_GROUPS[group].tools.some((name) => name in tools),
  );
}

/**
 * Adds the loader and reports which tools it gates. The returned set is live: loading a group
 * adds its names to it, and the runtime offers only the tools it holds (on Claude it sends the
 * others deferred, out of the model's context: see deferred-tools.ts).
 */
export function deferTools(
  tools: ToolSet,
  loaded: Set<string>,
  /** A group's summary as this run has it, where the default would say something untrue. */
  summaries: Partial<Record<ToolGroup, string>> = {},
): { gated: Set<string> } {
  const groups = offeredGroups(tools);
  const gated = new Set(
    Object.keys(tools).filter((name) => groups.includes(deferred.get(name) as ToolGroup)),
  );

  if (gated.size === 0) {
    return { gated };
  }

  tools.load_tools = tool({
    description: `Load a group of tools before using it. ${groups
      .map((group) => `${group}: ${summaries[group] ?? TOOL_GROUPS[group].summary}`)
      .join('. ')}.`,
    inputSchema: z.object({
      groups: z.array(z.enum(groups as [ToolGroup, ...ToolGroup[]])).min(1),
    }),
    execute: async ({ groups: chosen }) => {
      for (const group of chosen) {
        for (const name of TOOL_GROUPS[group].tools) {
          if (name in tools) {
            loaded.add(name);
          }
        }
      }

      return { loaded: [...loaded] };
    },
  });

  return { gated };
}

/**
 * The profile's schedules, managed by the agent as fully as by the owner. A schedule runs the
 * instruction as a new turn in its conversation at the time; in a chat, the answer goes out
 * on the channel. Times are read in the owner's zone unless one is named.
 */
function scheduleTools(
  schedules: NonNullable<ToolServices['schedules']>,
  run: Run,
  zone: () => Promise<string>,
): ToolSet {
  const timing = {
    at: z
      .string()
      .optional()
      .describe(
        'A single time: ISO 8601 with offset (2026-10-02T15:00:00-03:00 or …Z), ISO without offset (treated as UTC), or a relative delay (+30s, +5m, +1h, +2d). Exclusive with cron.',
      ),
    cron: z
      .string()
      .optional()
      .describe(
        'A repetition, five cron fields: minute hour day-of-month month day-of-week. "0 8 * * *" is every day at 08:00; "30 9 * * 1-5" is weekdays at 09:30. At most every 5 minutes. Exclusive with at.',
      ),
    timeZone: z
      .string()
      .optional()
      .describe(
        "IANA zone the time is read in. Default: the gateway's, the one the current time above is given in.",
      ),
  };

  return {
    list_schedules: tool({
      description: 'List this profile’s schedules: what, when, where, whether on, and when next.',
      inputSchema: z.object({}),
      execute: async () => schedules.list(run.profileId),
    }),
    create_schedule: tool({
      description:
        'Do something later, once or on a repetition: remind the owner, send a summary every morning, check something weekly. At the time, the instruction runs as a new turn in the chosen conversation — this one unless you give another session id, such as a WhatsApp group from your conversations — and your answer there goes out on its channel. Write the instruction as the request you will receive then, with everything needed and nothing assumed from this conversation.',
      inputSchema: z.object({
        name: z.string().min(1).max(80).describe('Short, for the owner’s list: "Morning summary".'),
        instruction: z.string().min(1).max(4000),
        sessionId: z.string().uuid().optional(),
        ...timing,
      }),
      execute: async ({ sessionId, timeZone, ...input }) =>
        schedules.create(
          run.profileId,
          { ...input, sessionId: sessionId ?? run.sessionId, timeZone: timeZone ?? (await zone()) },
          'agent',
        ),
    }),
    update_schedule: tool({
      description:
        'Change a schedule: its name, instruction, conversation, time, zone, or switch it off (enabled: false) and on. A new time replaces the old one.',
      inputSchema: z.object({
        id: z.string().uuid(),
        name: z.string().min(1).max(80).optional(),
        instruction: z.string().min(1).max(4000).optional(),
        sessionId: z.string().uuid().optional(),
        enabled: z.boolean().optional(),
        ...timing,
      }),
      execute: async ({ id, ...patch }) => schedules.update(run.profileId, id, patch),
    }),
    delete_schedule: tool({
      description: 'Delete a schedule for good. To pause one instead, switch it off.',
      inputSchema: z.object({ id: z.string().uuid() }),
      execute: async ({ id }) => schedules.remove(run.profileId, id),
    }),
  };
}
