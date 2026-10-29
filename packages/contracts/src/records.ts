import { z } from 'zod';
import { groupTurnSchema } from './channels.js';
import { agentCallOriginSchema } from './peers.js';
import {
  contextPolicySchema,
  modelSchema,
  profileSchema,
  protectionModeSchema,
  sessionObjectiveSchema,
  sessionSchema,
} from './profile.js';
import { projectSchema } from './projects.js';
import { modelSelectionSchema } from './providers.js';
import { runProgressSchema } from './run-progress.js';
import { subagentSchema } from './work.js';

const uuid = z.uuid();
const timestamp = z.iso.datetime();

export const profileRecordSchema = profileSchema.extend({
  id: uuid,
  version: z.number().int().positive(),
  createdAt: timestamp,
  updatedAt: timestamp,
});

export const sessionRecordSchema = sessionSchema.extend({
  // Null until the agent has read the first message and named it.
  title: z.string().max(160).nullable(),
  id: uuid,
  profileId: uuid,
  projectId: uuid.optional(),
  remoteMachineId: uuid.optional(),
  // Only on the session a pair of agents shares: the profile on the other side of it. The
  // session belongs to this profile alone; the peer never reads it.
  peerProfileId: uuid.optional(),
  // On a channel conversation: with one person, or with a group of them.
  scope: z.enum(['direct', 'group']).optional(),
  /**
   * What the conversation held before `summarizedUpTo`, written by the agent's own model when
   * the history outgrew what a request may carry. The turns themselves are kept in the
   * database and stay readable in the panel; only the prompt stops carrying them.
   */
  summary: z.string().max(20_000).optional(),
  summarizedUpTo: timestamp.optional(),
  summarizedThroughId: uuid.optional(),
  /** Chosen for this conversation alone; absent, it runs on the profile's model defaults. */
  model: modelSelectionSchema.optional(),
  /** Whether the agent asks before it acts here. Every conversation starts asking. */
  protection: protectionModeSchema.default('ask'),
  /**
   * Durable work the agent should finish across turns. Absent when nothing is in progress.
   * While `open`, the gateway queues follow-up runs after a completed slice.
   */
  objective: sessionObjectiveSchema.optional(),
  createdAt: timestamp,
});

export const projectRecordSchema = projectSchema;

/**
 * A session as a list shows it: with the last thing said in it, cut to a line, so the owner
 * reads where each conversation stands without opening it.
 */
export const sessionSummarySchema = sessionRecordSchema.extend({
  lastMessage: z
    .strictObject({
      role: z.enum(['user', 'assistant']),
      text: z.string().max(200),
      at: timestamp,
    })
    .optional(),
});

export const messagePurposeSchema = z.enum(['answer', 'resume']);

export const messageRecordSchema = z.strictObject({
  id: uuid,
  profileId: uuid,
  sessionId: uuid,
  // Absent on what the agent read in a group without being called: no run answered it.
  runId: uuid.optional(),
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  // Who wrote it, in a room where several people write: their id on the channel and the name
  // they showed. The content still carries the name first, because the agent reads it there.
  author: z.strictObject({ id: z.string(), name: z.string().optional() }).optional(),
  // In an agent conversation this profile started: the other agent's run that answers it, in
  // that agent's own session. The asking agent only carries the message; the other one works.
  call: z.strictObject({ profileId: uuid, sessionId: uuid, runId: uuid }).optional(),
  /**
   * A turn the gateway wrote around a pause, not something said in the conversation: `answer`
   * is the reply to a question or a decision, which the panel shows in its card instead, and
   * `resume` is the note that tells the agent to carry on. The agent reads both as written; a
   * reader of the conversation needs neither.
   */
  purpose: messagePurposeSchema.optional(),
  createdAt: timestamp,
});

/** Someone who wrote in a group conversation, and the picture they show on its channel. */
export const personSchema = z.strictObject({
  id: z.string(),
  name: z.string().optional(),
  avatar: z.string().optional(),
});

export const memoryRecordSchema = z.strictObject({
  id: z.string(),
  profileId: uuid,
  key: z.string(),
  content: z.string(),
  version: z.number().int().positive(),
  sourceSessionId: uuid.optional(),
  // The keys of the memories recalled together with this one.
  links: z.array(z.string()).optional(),
  updatedAt: timestamp,
});

/**
 * Counts, not money. `inputTokens` is what was sent and `outputTokens` what came back;
 * `cachedInputTokens` is the part of the input the provider served from its own cache and
 * usually bills differently, so it is kept apart rather than folded into a total. `estimated`
 * marks a run where at least one step reported no usage and the gateway counted the prompt
 * itself — a number to read as an order of magnitude, never as an invoice.
 */
export const usageSchema = z.strictObject({
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  cachedInputTokens: z.number().nonnegative().default(0),
  estimated: z.boolean().default(false),
  steps: z.number().int().nonnegative(),
});

/**
 * A structured owner question that parked this run as `waiting`. Cleared when the run leaves
 * that status. Choices are optional; when present, channels prefer native polls and the panel
 * shows buttons.
 */
export const runQuestionSchema = z.strictObject({
  id: uuid,
  prompt: z.string().trim().min(1).max(2000),
  choices: z.array(z.string().trim().min(1).max(100)).min(2).max(12).optional(),
  /** The choice the agent would make, shown as such; always one of `choices`. */
  recommended: z.string().trim().min(1).max(100).optional(),
  askedAt: timestamp,
  // Kept once answered, so the question still reads as a question with its answer marked.
  answer: z.string().max(8000).optional(),
  answeredAt: timestamp.optional(),
  answeredBy: z.enum(['owner', 'contact']).optional(),
});

/**
 * An action the agent wants to take, parked until a person who may approve it decides. The
 * call is kept exactly as the agent asked for it, apart from this record, and an approval runs
 * that call and no other; `request` is only how it reads, bounded and with secrets masked.
 */
export const runApprovalSchema = z.strictObject({
  id: uuid,
  toolCallId: z.string().min(1).max(200),
  toolName: z.string().min(1).max(200),
  kind: z.enum(['machine', 'service', 'message']),
  title: z.string().trim().min(1).max(140),
  detail: z.string().max(600),
  /** The yes button, in the action's own words: "Delete 12 projects" rather than "Approve". */
  confirmLabel: z.string().trim().min(1).max(40),
  /** The tool input as JSON text, cut to 4000 characters. */
  request: z.string().max(4000),
  askedAt: timestamp,
  decision: z.enum(['approved', 'rejected']).optional(),
  decidedAt: timestamp.optional(),
  /** The owner from the panel, or a contact allowed to approve, from their chat. */
  decidedBy: z.enum(['owner', 'contact']).optional(),
  /** What the person said when their reply was neither a yes nor a no. */
  note: z.string().max(500).optional(),
});

export const runApprovalInputSchema = z.strictObject({
  decision: z.enum(['approve', 'reject']),
  requestKey: z.string().min(1).max(120).optional(),
});

/** Owner answer to a waiting run's question. */
export const runAnswerSchema = z.strictObject({
  text: z.string().trim().min(1).max(8_000),
  requestKey: z.string().min(1).max(120).optional(),
});

export const runRecordSchema = z.strictObject({
  id: uuid,
  profileId: uuid,
  sessionId: uuid,
  subagent: subagentSchema.optional(),
  requestKey: z.string(),
  input: z.string(),
  status: z.enum([
    'queued',
    'running',
    'waiting',
    'completed',
    'failed',
    'interrupted',
    'cancelled',
  ]),
  createdAt: timestamp,
  updatedAt: timestamp,
  error: z.string().optional(),
  output: z.string().optional(),
  usage: usageSchema.optional(),
  continuationOf: uuid.optional(),
  model: modelSchema.optional(),
  modelSelection: modelSelectionSchema.optional(),
  contextPolicy: contextPolicySchema.optional(),
  // Present when another profile asked for this run; it carries the chain's spent budget.
  call: agentCallOriginSchema.optional(),
  // Present when a group message started this run; it carries the room's spent budget.
  group: groupTurnSchema.optional(),
  progress: runProgressSchema.optional(),
  /**
   * What the agent said before the answer, one entry per step that spoke on its way to using a
   * tool. A chat channel sends each as it appears, so the conversation moves while the work
   * happens instead of arriving all at once at the end. The final answer is not in here.
   */
  commentary: z.array(z.string().max(4000)).max(20).optional(),
  /** Set when the agent that asked stopped waiting: where its late answer is to be carried. */
  relayTo: uuid.optional(),
  /** Present while status is `waiting`: the owner question that parked this run. */
  question: runQuestionSchema.optional(),
  /**
   * The action that parked this run, pending while it waits and kept with its decision
   * afterwards. A waiting run carries either this or a question, never both.
   */
  approval: runApprovalSchema.optional(),
});

/**
 * How much a profile ran on one day. Days with nothing are left out, because a year of zeroes
 * is the shape of the calendar rather than anything the profile did.
 */
/**
 * Which midnight ends a day. A calendar drawn in UTC puts an evening in Brazil on tomorrow's
 * square, so the reader is told the wrong day about their own work. Absent means UTC.
 */
export const activityQuerySchema = z.strictObject({
  zone: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9+_-]*(?:\/[A-Za-z0-9+_-]+)*$/)
    .max(64)
    .optional(),
});

export const activityDaySchema = z.strictObject({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  runs: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative(),
});

const tokenMixSchema = z.strictObject({
  // Input read fresh, input served from the provider's cache, and output written.
  input: z.number().int().nonnegative(),
  cached: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
});

/**
 * How the model was paid for: per token at list price, inside a subscription (a Claude token or
 * a ChatGPT sign-in, where a token has no price), or at a price the catalog does not know.
 */
export const billingSchema = z.enum(['metered', 'subscription', 'unknown']);

export const statsQuerySchema = z.strictObject({
  days: z.coerce.number().int().min(1).max(3660).default(30),
});

const subscriptionWindowSchema = z.strictObject({
  usedPercent: z.number().finite().nonnegative(),
  resetsAt: timestamp.nullable(),
});

export const subscriptionUsageSchema = z.strictObject({
  provider: z.enum(['codex', 'claude']),
  status: z.enum(['available', 'unavailable']),
  fiveHour: subscriptionWindowSchema.nullable(),
  weekly: subscriptionWindowSchema.nullable(),
});

export type SubscriptionUsage = z.infer<typeof subscriptionUsageSchema>;

/** What a profile has done: since it was created, and over the period asked for. */
export const profileStatsSchema = z.strictObject({
  since: timestamp,
  subscriptions: z.array(subscriptionUsageSchema),
  totals: z.strictObject({
    turns: z.number().int().nonnegative(),
    // Time its turns took, start to finish, added up.
    workedMs: z.number().int().nonnegative(),
    conversations: z.number().int().nonnegative(),
    skillsWritten: z.number().int().nonnegative(),
    memories: z.number().int().nonnegative(),
  }),
  period: z.strictObject({
    days: z.number().int().positive(),
    from: timestamp,
    turns: z.number().int().nonnegative(),
    tokens: tokenMixSchema,
    // Estimated from list prices; null when nothing in the period had a known price.
    cost: z.number().nonnegative().nullable(),
    // Part of the tokens used inside a subscription or at an unknown price, left out of cost.
    unpricedTokens: z.number().int().nonnegative(),
    activeDays: z.number().int().nonnegative(),
    daily: z.array(z.strictObject({ day: z.string(), tokens: z.number().int().nonnegative() })),
  }),
  models: z.array(
    z.strictObject({
      provider: z.string(),
      modelId: z.string(),
      billing: billingSchema,
      turns: z.number().int().nonnegative(),
      tokens: tokenMixSchema,
      cost: z.number().nonnegative().nullable(),
    }),
  ),
  channels: z.array(
    z.strictObject({
      channel: z.string(),
      conversations: z.number().int().nonnegative(),
      turns: z.number().int().nonnegative(),
      tokens: z.number().int().nonnegative(),
    }),
  ),
  tools: z.array(
    z.strictObject({
      name: z.string(),
      calls: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
    }),
  ),
});

export type ProfileStats = z.infer<typeof profileStatsSchema>;

export const revisionRecordSchema = z.strictObject({
  id: z.string(),
  profileId: uuid,
  profile: profileRecordSchema,
  createdAt: timestamp,
});

export const eventSchema = z.strictObject({
  id: z.number().int(),
  profileId: uuid,
  runId: uuid.optional(),
  type: z.string(),
  data: z.unknown(),
  createdAt: timestamp,
});

export type Usage = z.infer<typeof usageSchema>;

export type ModelConfig = z.infer<typeof profileSchema>['model'];

export type Profile = z.infer<typeof profileRecordSchema>;

export type Session = z.infer<typeof sessionRecordSchema>;

export type Message = z.infer<typeof messageRecordSchema>;
export type Person = z.infer<typeof personSchema>;

export type Memory = z.infer<typeof memoryRecordSchema>;

export type RunQuestion = z.infer<typeof runQuestionSchema>;

export type RunAnswer = z.infer<typeof runAnswerSchema>;

export type Run = z.infer<typeof runRecordSchema> & {
  profile: Profile;
  leaseOwner?: string;
  leaseUntil?: number;
};

export type ActivityDay = z.infer<typeof activityDaySchema>;

export type ProfileRevision = z.infer<typeof revisionRecordSchema>;

export type GatewayEvent = z.infer<typeof eventSchema>;

export const checkpointSchema = z.strictObject({
  id: z.uuid(),
  profileId: z.uuid(),
  runId: z.uuid(),
  data: z.unknown(),
  createdAt: z.iso.datetime(),
});

export type Checkpoint = z.infer<typeof checkpointSchema>;

/**
 * One tool the agent used during a turn, as the owner's timeline shows it: what it was, how long
 * it took and how it ended. `stopped` is a tool that started in a turn that ended before it came
 * back. What it received and returned stays in the run's checkpoints.
 */
/**
 * What one file write changed, line by line, for the owner to read: git's hunks with each line
 * numbered on the side it belongs to. Bounded for reading (`truncated` says it was cut); the
 * agent never receives it.
 */
export const codeDiffSchema = z.strictObject({
  /** Relative to the agent's workspace when the file is inside it. */
  path: z.string().max(4096),
  /** A highlighting hint from the file's extension, such as `typescript`. */
  language: z.string().max(40).optional(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  /** The write made the file. */
  created: z.boolean().optional(),
  hunks: z
    .array(
      z.strictObject({
        oldStart: z.number().int().nonnegative(),
        oldLines: z.number().int().nonnegative(),
        newStart: z.number().int().nonnegative(),
        newLines: z.number().int().nonnegative(),
        /** The line the hunk sits under, as git's `@@ … @@ header`. */
        header: z.string().max(120).optional(),
        lines: z
          .array(
            z.strictObject({
              kind: z.enum(['context', 'add', 'del']),
              old: z.number().int().positive().optional(),
              new: z.number().int().positive().optional(),
              text: z.string().max(520),
            }),
          )
          .max(400),
      }),
    )
    .max(400),
  truncated: z.boolean().optional(),
});

export const toolStepSchema = z.strictObject({
  toolCallId: z.string(),
  toolName: z.string(),
  status: z.enum(['running', 'done', 'failed', 'refused', 'uncertain', 'stopped']),
  startedAt: timestamp,
  finishedAt: timestamp.optional(),
  error: z.string().optional(),
  /** What a file write changed, for the tools that write files. */
  diff: codeDiffSchema.optional(),
});

export const runTimelineSchema = z.strictObject({
  runId: uuid,
  steps: z.array(toolStepSchema),
  /** What the run asked to do and how it was decided, for a card in the conversation. */
  approval: runApprovalSchema.optional(),
  /** The question the run is waiting on, while it waits. */
  question: runQuestionSchema.optional(),
});

export type ToolStep = z.infer<typeof toolStepSchema>;
export type CodeDiff = z.infer<typeof codeDiffSchema>;
export type RunTimeline = z.infer<typeof runTimelineSchema>;
export type RunApproval = z.infer<typeof runApprovalSchema>;

export const continuationSchema = z.strictObject({
  text: z.string().trim().min(1).max(4000),
  requestKey: z.string().min(1).max(120),
  reconciliation: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .describe(
      'Describe which external effects completed or were verified absent before continuing.',
    ),
});
