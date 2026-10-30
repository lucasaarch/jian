import { generateText, type JSONValue, type LanguageModel, type LanguageModelUsage } from 'ai';
import type { Judge } from '../decisions/service.js';
import { noul } from '../decisions/service.js';
import { withClaudeCodeIdentity } from '../providers/claude-subscription.js';
import { type ActionKind, requestText } from './guard.js';

/**
 * In a conversation on Auto, what may not run. Very little: an action whose harm cannot be
 * undone or contained — data, infrastructure or backups destroyed wholesale, credentials put
 * where they leak. Everything else runs, as in Full access, so a run nobody watches never
 * stops to wait for a person.
 */
export type Verdict = { allowed: true } | { allowed: false; reason: string };

export type Guardrail = (action: {
  toolName: string;
  kind: ActionKind;
  input: unknown;
}) => Promise<Verdict>;

const FORCE_PUSH =
  "it force-pushes over a repository's default branch, which rewrites history others build on";

/**
 * The branches a forced push may not overwrite unattended. GitHub's own default branch is not
 * known before the call runs, so the usual names stand for it; the judge reads the rest.
 */
const DEFAULT_BRANCHES = new Set(['main', 'master', 'trunk']);

/** Tools that run what they are given; what they write elsewhere is code, not an action. */
const EXECUTING = new Set(['run_command', 'run_remote_command', 'remote_computer']);

/**
 * The plainest catastrophes, refused without asking anyone: what no unattended run should do,
 * whatever it was told. Each names what it guards against, which is what the agent reads.
 */
const RULES: Array<{ pattern: RegExp; why: string }> = [
  {
    pattern:
      /\brm\s+(?:-\w*\s+)*-\w*[rR]\w*\s+(?:-\w*\s+)*(?:\/|~|\$HOME|\/\*|\*|\.\.?)(?=\s|;|&|\||$)/,
    why: 'it deletes a root, home or whole directory tree',
  },
  { pattern: /\bmkfs(?:\.\w+)?\b|\bdd\b[^\n]*\bof=\/dev\//, why: 'it overwrites a disk' },
  {
    pattern: /\bdrop\s+(?:database|schema|table)\b/i,
    why: 'it drops a database, schema or table',
  },
  { pattern: /\btruncate\s+(?:table\s+)?\w/i, why: 'it empties a table' },
  {
    pattern: /\bdelete\s+from\s+[\w."`[\]]+\s*(?:;|$|"|'|\))/im,
    why: 'it deletes every row of a table, with no WHERE',
  },
  {
    pattern: /\bupdate\s+[\w."`[\]]+\s+set\b(?![^;]*\bwhere\b)[^;]*(?:;|$)/im,
    why: 'it changes every row of a table, with no WHERE',
  },
  {
    pattern: /\b(?:terraform|tofu|pulumi)\s+destroy\b|\bcdk\s+destroy\b/,
    why: 'it destroys infrastructure',
  },
  {
    pattern: /\bkubectl\s+delete\s+(?:ns|namespaces?|pv|pvc|--all)\b/,
    why: 'it deletes a namespace or volumes',
  },
  {
    pattern: /\bdocker\s+(?:volume\s+(?:rm|prune)|system\s+prune\b[^\n]*--volumes)/,
    why: 'it deletes container volumes',
  },
  {
    pattern: /\baws\s+s3\s+(?:rb\b[^\n]*--force|rm\b[^\n]*--recursive)/,
    why: 'it deletes a storage bucket’s contents',
  },
  {
    pattern: /\b(?:rm|rclone\s+(?:delete|purge)|restic\s+forget)\b[^\n]*\bbackups?\b/i,
    why: 'it deletes backups',
  },
  {
    pattern:
      /\b(?:cat|less|more|head|tail|bat)\s+[^\n|;]*(?:\.env\b|id_(?:rsa|ed25519|ecdsa)\b(?!\.pub)|\.aws\/credentials|\.netrc|\.pgpass)/,
    why: 'it prints credentials into the conversation',
  },
  {
    pattern: /^\s*(?:printenv|env|export\s+-p|set)\s*$/m,
    why: 'it prints every environment variable, credentials included',
  },
  {
    pattern: /\becho\s+[^\n]*\$\{?\w*(?:KEY|TOKEN|SECRET|PASSWORD|PASS)\w*\}?/i,
    why: 'it prints a credential into the conversation',
  },
  {
    // `git push` with a force flag or a `+` refspec, aimed at a usual default branch.
    pattern:
      /\bgit\s+push\b(?=[^\n;&|]*\s(?:-f\b|--force\b|--force-with-lease\b|--force-with-lease=|\+))(?=[^\n;&|]*\s\+?(?:[^\s:]*:)?(?:refs\/heads\/)?(?:main|master|trunk)(?=\s|$|;|&|\|))/,
    why: FORCE_PUSH,
  },
];

/** What a rule reads: the command of a tool that runs one, every field of a service's call. */
function readable(toolName: string, kind: ActionKind, input: unknown): string | undefined {
  if (EXECUTING.has(toolName)) {
    const command = (input as { command?: unknown })?.command;
    return typeof command === 'string' ? command : JSON.stringify(input ?? null);
  }
  // A service runs what it is handed: a database MCP's query is a query.
  if (kind === 'service') return JSON.stringify(input ?? null).replaceAll('\\n', '\n');
  return undefined;
}

export function ruleVerdict(toolName: string, kind: ActionKind, input: unknown): Verdict {
  if (toolName === 'github_git') {
    const call = (input ?? {}) as { action?: unknown; force?: unknown; branch?: unknown };
    if (
      call.action === 'push' &&
      call.force === true &&
      typeof call.branch === 'string' &&
      DEFAULT_BRANCHES.has(call.branch.trim().toLowerCase())
    ) {
      return { allowed: false, reason: refusal(FORCE_PUSH) };
    }
  }
  const text = readable(toolName, kind, input);
  if (text === undefined) return { allowed: true };

  for (const rule of RULES) {
    if (rule.pattern.test(text)) return { allowed: false, reason: refusal(rule.why) };
  }
  return { allowed: true };
}

const refusal = (why: string) =>
  `Not run: this conversation is on Auto, and its guardrail refused the action because ${why}. Nothing was changed. Do it another way that can be undone, scoped to what the task needs, or tell the owner what you would do so they can do it themselves.`;

const INSTRUCTIONS = `You are the guardrail of an autonomous agent that acts with nobody watching. Block an action only when its harm is catastrophic and cannot be undone or contained: destroying production data, databases, infrastructure or backups wholesale; deleting or overwriting whole systems, disks or home directories; changing or deleting every row of a table; force-pushing over a repository's default branch; or putting passwords, tokens or private keys where they leak — printed into the conversation, sent to someone, or published. Everything else is allowed, even when it changes things: editing, writing or deleting specific files, writing code or migrations that contain such statements, running tests and builds, installing packages, committing, pushing a branch, opening pull requests, deploying, restarting services, sending ordinary messages. When unsure, allow.`;

const ASK = `${INSTRUCTIONS}\n\nAnswer on one line: ALLOW, or BLOCK followed by a short reason in English.`;

/** A judgment by the conversation's own model, at its lowest effort, beside the turn. */
export type GuardModel = {
  model: LanguageModel;
  /** A Claude subscription checks that the system prompt is Claude Code's. */
  subscription: boolean;
  providerOptions?: Record<string, Record<string, JSONValue>>;
  account: (usage: LanguageModelUsage, text: string) => Promise<unknown>;
};

/**
 * The guardrail of one run: the fixed rules first, then Jev where it is set up and its use is
 * on, then the run's own model. A judge that cannot answer leaves the action to the rules,
 * which already let it through: Auto refuses only what someone found catastrophic.
 */
export function guardrail({
  judge,
  model,
  signal,
}: {
  judge?: Judge;
  model?: GuardModel;
  signal?: AbortSignal;
}): Guardrail {
  return async ({ toolName, kind, input }) => {
    const ruled = ruleVerdict(toolName, kind, input);
    if (!ruled.allowed) return ruled;

    const action = `Tool: ${toolName} (${kind})\nInput:\n${requestText(input)}`;
    const answers = await judge?.(
      action,
      {
        catastrophic: {
          type: 'noul',
          instructions: `${INSTRUCTIONS}\n\nYes means block it.`,
          criteria: { true: 'catastrophic, block it', false: 'allowed' },
        },
      },
      { use: 'guardrail', timeoutMs: 8_000, ...(signal ? { signal } : {}) },
    );
    const yes = noul(answers?.catastrophic);
    if (yes !== undefined) {
      return yes >= 0.8
        ? { allowed: false, reason: refusal('it judged the action catastrophic') }
        : { allowed: true };
    }

    if (!model) return { allowed: true };
    try {
      const { text, usage } = await generateText({
        model: model.model,
        system: model.subscription ? withClaudeCodeIdentity(ASK) : ASK,
        prompt: action,
        ...(model.providerOptions ? { providerOptions: model.providerOptions } : {}),
        maxRetries: 1,
        maxOutputTokens: 1000,
        abortSignal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(20_000)]),
      });
      await model.account(usage, text).catch(() => {});
      const line = text.trim().split('\n').find(Boolean) ?? '';
      const blocked = /^\W*block\b/i.exec(line);
      if (!blocked) return { allowed: true };
      const why = line
        .slice(blocked[0].length)
        .replace(/^[\s:—-]+/, '')
        .trim();
      return {
        allowed: false,
        reason: refusal(
          why
            ? `it judged it catastrophic: ${why.slice(0, 200)}`
            : 'it judged the action catastrophic',
        ),
      };
    } catch {
      return { allowed: true };
    }
  };
}
