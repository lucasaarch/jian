import {
  agentCallSchema,
  conversationSubagentInputSchema,
  decisionUseSchema,
  MAX_OBJECTIVE_TEXT,
  memoryKeySchema,
  memorySchema,
  type Run,
} from '@jian/contracts';
import { type ToolSet, tool } from 'ai';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { Coordination } from '../coordination/service.js';
import { assertFound, GatewayError } from '../core/errors.js';
import { gatewayTimeZone } from '../core/time-zone.js';
import type { Decisions, Question } from '../decisions/service.js';
import type { Outreach } from '../errands/port.js';
import { sameSubject } from '../memories/duplicates.js';
import type { MemoryWriter } from '../memories/port.js';
import type { PeerAgents } from '../peers/port.js';
import type { ProfileAdmin } from '../profiles/port.js';
import type { Remote } from '../remote/service.js';
import type { RunExecution, RunReader } from '../runs/port.js';
import type { Schedules } from '../schedules/service.js';
import type { SessionNamer, SessionReader, SessionSummarizer } from '../sessions/port.js';
import type { Sessions } from '../sessions/service.js';
import { findSkill } from '../skills/builtin/index.js';
import { skillTools } from '../skills/tools.js';
import type { SshKeys } from '../ssh/service.js';
import type { Stats } from '../stats/service.js';
import type { Store } from '../storage/database.js';
import { artifacts, checkpoints } from '../storage/schema.js';
import type { Subscriptions } from '../subscriptions/service.js';
import type { Work } from '../tasks/service.js';
import { AskUserPause } from './ask-user.js';
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
    Partial<Pick<Sessions, 'setObjective' | 'writeObjective'>>;
  runs: RunReader;
  peers: PeerAgents;
  lifecycle: RunExecution;
  errands: Outreach;
  store: Store;
  decisions?: Pick<Decisions, 'ask' | 'judge'>;
  schedules?: Pick<Schedules, 'list' | 'create' | 'update' | 'remove'>;
  subscriptions?: Pick<Subscriptions, 'list' | 'create' | 'update' | 'remove'>;
  settings?: { timeZone(): Promise<string> };
  stats?: Pick<Stats, 'stats' | 'usageRuns'>;
  work?: Pick<Work, 'spawnInConversation'>;
  sshKeys: Pick<SshKeys, 'list' | 'create' | 'remove'>;
  remote?: Pick<Remote, 'listForProfile' | 'execute'>;
};

export function profileTools(
  services: ToolServices,
  run: Run,
  gitAccess: { readOnly: string[]; writable: string[] } = { readOnly: [], writable: [] },
): ToolSet {
  const coordination = new Coordination(services);
  const rechecked = new Set<string>();

  const tools: ToolSet = {
    list_ssh_keys: tool({
      description:
        'List this profile’s SSH keys. Returns names, public keys and fingerprints only; private keys never leave the workspace.',
      inputSchema: z.object({}),
      execute: async () => services.sshKeys.list(run.profileId),
    }),

    create_ssh_key: tool({
      description:
        'Create an Ed25519 SSH key for this profile through Jian. Never use ssh-keygen or create SSH keys through the shell.',
      inputSchema: z.object({ name: z.string().trim().min(1).max(80) }),
      execute: async ({ name }) => services.sshKeys.create(run.profileId, { name }),
    }),

    delete_ssh_key: tool({
      description:
        'Delete one of this profile’s SSH keys. List the keys first and use the returned id.',
      inputSchema: z.object({ id: z.uuid() }),
      execute: async ({ id }) => services.sshKeys.remove(run.profileId, id),
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
              'Ask the owner a required question and pause this run until they answer. Prefer this over finishing the turn or block_session_objective when you need a concrete choice or fact to continue. Optional choices become buttons in the panel and a reply keyboard on Telegram.',
            inputSchema: z.object({
              prompt: z.string().trim().min(1).max(2000),
              choices: z.array(z.string().trim().min(1).max(100)).min(2).max(12).optional(),
            }),
            execute: async ({
              prompt,
              choices,
            }: {
              prompt: string;
              choices?: string[];
            }): Promise<{ paused: true }> => {
              throw new AskUserPause({ prompt, ...(choices?.length ? { choices } : {}) });
            },
          }),
        }
      : {}),

    ...(services.work && !run.subagent
      ? {
          spawn_subagent: tool({
            description:
              'Start a scoped subagent in this conversation for a focused assignment. Give it the objective and necessary context in the brief, and media IDs for needed images; it does not inherit this conversation. It uses the same profile workspace as you (same HOME and checkouts). The call returns when queued, and the result is delivered here when it finishes.',
            inputSchema: conversationSubagentInputSchema,
            execute: async (input, options) =>
              services.work?.spawnInConversation(run, input, options.toolCallId),
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

    ...(services.subscriptions ? subscriptionTools(services.subscriptions, run) : {}),

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
      execute: async () => services.sessions.sessions(run.profileId),
    }),

    read_session: tool({
      description: 'Read recent messages in one of this profile’s sessions.',
      inputSchema: z.object({ sessionId: z.string().uuid() }),
      execute: async ({ sessionId }) =>
        (await services.sessions.messages(run.profileId, sessionId, 20)).map((m) => ({
          role: m.role,
          content: m.content.slice(0, 2000),
          createdAt: m.createdAt,
        })),
    }),

    load_skill: tool({
      description: 'Load instructions for a skill enabled on this profile.',
      inputSchema: z.object({ name: z.string() }),
      execute: async ({ name }) => {
        const skill = findSkill(run.profile, name);

        if (!skill) {
          throw new GatewayError(404, 'Skill not found');
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
      description: 'Read a bounded page of a stored tool result by artifact id.',
      inputSchema: z.object({
        artifactId: z.string().uuid(),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(16000).default(16000),
      }),
      execute: async ({ artifactId, offset, limit }) => {
        // The profile in the where clause is the owner check: another profile's artifact is
        // not found rather than read, whatever id the model guesses.
        const [record] = await services.store.db
          .select({ content: artifacts.content })
          .from(artifacts)
          .where(and(eq(artifacts.id, artifactId), eq(artifacts.profileId, run.profileId)))
          .limit(1);

        const { content } = assertFound(record, 'Artifact');
        return artifactPage(content, offset, limit, run);
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
        'Write text into another of your conversations. A WhatsApp or Telegram conversation — a person or an approved group — receives it on that channel, as a message from you; any other session gets it in its inbox. Text only: to send a file, a sticker, an image or a voice note there, use send_file, send_sticker, generate_image or generate_speech with its sessionId. Idempotent by requestKey.',
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

  if (run.profile.reachableByAgents) {
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
  }

  if (run.profile.allowShell) {
    Object.assign(tools, shellTools(run.profileId, gitAccess));
    if (services.remote) {
      Object.assign(tools, remoteTools(run, services.remote, services.store));
    }
  }

  // Writing its own skills is part of every agent's work, not of managing itself: what it
  // writes is marked as its own, shown to the owner under Skills, and only it can change it.
  Object.assign(tools, skillTools(services.profiles, run));

  if (run.profile.allowSelfManagement) {
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
        if (!(await services.profiles.profile(run.profileId)).allowSelfManagement) {
          throw new GatewayError(403, 'Self-management is disabled');
        }

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
        if (!(await services.profiles.profile(run.profileId)).allowSelfManagement) {
          throw new GatewayError(403, 'Self-management is disabled');
        }

        const { apiKeyEnv: _env, providerId: _provider, ...model } = run.profile.model;
        const created = await services.profiles.createProfile({ ...input, model });

        return { id: created.id, name: created.name };
      },
    });
  }

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
  subscriptions: {
    summary:
      'listen for GitHub CI finishing or a pull request merging by polling for state changes (optional webhook), and wake this conversation when they fire',
    tools: [
      'list_subscriptions',
      'create_subscription',
      'update_subscription',
      'delete_subscription',
    ],
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
      'open attachments, save them, send files and documents into any conversation, find and send stickers, generate images, and reply with voice',
    tools: [
      'analyze_media',
      'send_file',
      'save_attachment',
      'generate_image',
      'list_speech_voices',
      'generate_speech',
      'find_stickers',
      'send_sticker',
      'tag_sticker',
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
      'list Remote Control machines, run commands there, take screenshots, and pull or push files',
    tools: [
      'list_remote_machines',
      'run_remote_command',
      'take_remote_screenshot',
      'pull_remote_file',
      'push_remote_file',
    ],
  },
  web: {
    summary: 'search the web and read public pages',
    tools: ['web_search', 'fetch_url'],
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
      'delegate subagents, inspect checkpoints and output, manage resource leases, or compact context',
    tools: [
      'spawn_subagent',
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
    tools: ['list_contacts', 'message_contact'],
  },
  self: {
    summary: 'read and version your own identity, and create profiles',
    tools: ['read_identity', 'update_identity', 'create_profile'],
  },
} as const;

export type ToolGroup = keyof typeof TOOL_GROUPS;

const deferred = new Map<string, ToolGroup>(
  Object.entries(TOOL_GROUPS).flatMap(([group, entry]) =>
    entry.tools.map((name) => [name, group as ToolGroup] as const),
  ),
);

/** The groups this run can actually offer: a group whose tools are all absent is not one. */
export function offeredGroups(tools: ToolSet): ToolGroup[] {
  return (Object.keys(TOOL_GROUPS) as ToolGroup[]).filter((group) =>
    TOOL_GROUPS[group].tools.some((name) => name in tools),
  );
}

/**
 * Adds the loader and reports which tools it gates. The returned set is live: loading a group
 * adds its names to it, and the runtime sends only the tools it holds.
 */
export function deferTools(tools: ToolSet, loaded: Set<string>): { gated: Set<string> } {
  const groups = offeredGroups(tools);
  const gated = new Set(
    Object.keys(tools).filter((name) => groups.includes(deferred.get(name) as ToolGroup)),
  );

  if (gated.size === 0) {
    return { gated };
  }

  tools.load_tools = tool({
    description: `Load a group of tools before using it. ${groups
      .map((group) => `${group}: ${TOOL_GROUPS[group].summary}`)
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

function subscriptionTools(subscriptions: NonNullable<ToolServices['subscriptions']>, run: Run) {
  return {
    list_subscriptions: tool({
      description:
        'List this profile’s event subscriptions: what they listen for, which conversation they wake, whether they are on, next poll, and when they expire.',
      inputSchema: z.object({}),
      execute: async () => subscriptions.list(run.profileId),
    }),
    create_subscription: tool({
      description:
        'Watch a GitHub pull request for CI finishing or the PR closing/merging. The gateway polls GitHub on an interval and wakes this conversation only when that state changes (not every tick) — no webhook setup required. Listeners expire (default 1 hour; set durationSeconds for 30 minutes / 1 hour / 1 day). Keep or open a session objective so the wake continues the work. Optionally returns a webhookSecret if you later want a faster path.',
      inputSchema: z.object({
        name: z.string().min(1).max(80),
        instruction: z.string().min(1).max(4000),
        sessionId: z.string().uuid().optional(),
        owner: z.string().min(1).max(100),
        repo: z.string().min(1).max(100),
        pullNumber: z
          .number()
          .int()
          .positive()
          .describe('Pull request number to watch (required for polling CI or merge state).'),
        checkName: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe('Optional check run name filter, e.g. "Check".'),
        pollIntervalSeconds: z
          .number()
          .int()
          .min(15)
          .max(3600)
          .optional()
          .describe('Seconds between polls. Default 30.'),
        durationSeconds: z
          .number()
          .int()
          .min(300)
          .max(604_800)
          .optional()
          .describe(
            'How long to keep watching from now. Default 3600 (1 hour). Examples: 1800 (30 minutes), 86400 (1 day).',
          ),
        events: z
          .array(z.enum(['check_suite.completed', 'pull_request.closed']))
          .min(1)
          .max(8),
        enabled: z.boolean().optional(),
      }),
      execute: async ({
        sessionId,
        owner,
        repo,
        events,
        pullNumber,
        checkName,
        pollIntervalSeconds,
        durationSeconds,
        enabled,
        ...rest
      }) =>
        subscriptions.create(
          run.profileId,
          {
            ...rest,
            sessionId: sessionId ?? run.sessionId,
            source: 'github',
            filter: {
              owner,
              repo,
              events,
              pullNumber,
              ...(checkName ? { checkName } : {}),
              ...(pollIntervalSeconds !== undefined ? { pollIntervalSeconds } : {}),
            },
            ...(durationSeconds !== undefined ? { durationSeconds } : {}),
            enabled: enabled ?? true,
          },
          'agent',
        ),
    }),
    update_subscription: tool({
      description:
        'Change a subscription’s name, instruction, filter, session, enabled flag, or duration (extends expiresAt from now).',
      inputSchema: z.object({
        id: z.string().uuid(),
        name: z.string().min(1).max(80).optional(),
        instruction: z.string().min(1).max(4000).optional(),
        sessionId: z.string().uuid().optional(),
        owner: z.string().min(1).max(100).optional(),
        repo: z.string().min(1).max(100).optional(),
        pullNumber: z.number().int().positive().optional(),
        checkName: z.string().min(1).max(200).optional(),
        pollIntervalSeconds: z.number().int().min(15).max(3600).optional(),
        durationSeconds: z
          .number()
          .int()
          .min(300)
          .max(604_800)
          .optional()
          .describe('Reset how long to keep watching from now (e.g. 1800, 3600, 86400).'),
        events: z
          .array(z.enum(['check_suite.completed', 'pull_request.closed']))
          .min(1)
          .max(8)
          .optional(),
        enabled: z.boolean().optional(),
      }),
      execute: async ({
        id,
        owner,
        repo,
        events,
        pullNumber,
        checkName,
        pollIntervalSeconds,
        ...patch
      }) => {
        const touchingFilter =
          owner !== undefined ||
          repo !== undefined ||
          events !== undefined ||
          pullNumber !== undefined ||
          checkName !== undefined ||
          pollIntervalSeconds !== undefined;
        if (touchingFilter) {
          if (!owner || !repo || !events?.length) {
            throw new GatewayError(400, 'A filter patch needs owner, repo and events together');
          }
          return subscriptions.update(run.profileId, id, {
            ...patch,
            filter: {
              owner,
              repo,
              events,
              ...(pullNumber !== undefined ? { pullNumber } : {}),
              ...(checkName !== undefined ? { checkName } : {}),
              ...(pollIntervalSeconds !== undefined ? { pollIntervalSeconds } : {}),
            },
          });
        }
        return subscriptions.update(run.profileId, id, patch);
      },
    }),
    delete_subscription: tool({
      description: 'Delete an event subscription. To pause one instead, switch it off.',
      inputSchema: z.object({ id: z.string().uuid() }),
      execute: async ({ id }) => subscriptions.remove(run.profileId, id),
    }),
  };
}
