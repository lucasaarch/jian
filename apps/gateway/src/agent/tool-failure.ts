import { redactText } from './results.js';

/**
 * Keys and tokens by their look — OpenAI and Anthropic, Google, Groq, GitHub — and whatever
 * follows a bearer or an `api_key=`: an error can quote a credential this run never held.
 */
const CREDENTIAL_SHAPES =
  /\b(sk-[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{30,}|gsk_[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,})\b|\bBearer\s+\S+|\b(?:cookie|set-cookie|headers)\s*[:=][^\r\n]+|\b(api[_-]?key|token|secret|password|authorization)(["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi;

/** Fields safe to surface on a tool failure — enough for the agent to correct the call. */
const FAILURE_FIELDS = new Set([
  'message',
  'name',
  'error',
  'origin',
  'code',
  'format',
  'path',
  'issues',
  'details',
  'errors',
  'expected',
  'received',
  'minimum',
  'maximum',
  'validation',
  'data',
  'status',
  'statusCode',
  'documentation_url',
  'documentationUrl',
  'response',
  'responseBody',
  'resource',
  'field',
  'value',
  'hint',
]);

/** Upstream `@modelcontextprotocol/server-github` create_issue drops GitHub's `errors[]`. */
const BARE_GITHUB_VALIDATION = /Failed to create (?:issue|pull request):\s*Validation Failed\b/i;

const BARE_VALIDATION_HINT =
  'GitHub returned Validation Failed without field details. Common fixes: omit milestone ' +
  '(never pass 0 or -1), use only labels that already exist on the repo, require a non-empty ' +
  'title, and ensure assignees are collaborators. Prefer the official GitHub MCP ' +
  '(HTTP+OAuth or ghcr.io/github/github-mcp-server) for full validation payloads.';

/**
 * Pull a GitHub-style validation body out of prose the MCP server already put in the message
 * (`Details: {…}` from formatGitHubError) or out of JSON-RPC `data`.
 */
function githubValidationBody(text: string): Record<string, unknown> | undefined {
  const details = text.match(/\bDetails:\s*(\{[\s\S]*\})\s*$/i)?.[1];
  if (details) {
    try {
      const parsed: unknown = JSON.parse(details);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Keep scanning other carriers.
    }
  }

  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Walk an error and its causes the same way the runtime does for provider refusals. */
function causes(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current: unknown = error;

  while (current !== undefined && current !== null && !chain.includes(current)) {
    chain.push(current);
    current = current instanceof Error ? current.cause : undefined;
  }

  return chain;
}

/**
 * Merge MCP / GitHub validation carriers onto one object the agent can read: `errors[]`,
 * `documentation_url`, HTTP/status codes, and JSON-RPC `data` when the server sent them.
 */
export function enrichToolFailure(error: unknown): Record<string, unknown> {
  const enriched: Record<string, unknown> = {};
  const messages: string[] = [];

  for (const item of causes(error)) {
    if (item instanceof Error) {
      messages.push(item.message);
      enriched.name ??= item.name;
      // Own enumerable fields on MCPClientError (code, data, statusCode, …).
      Object.assign(enriched, { ...item });
      enriched.message = item.message;
    } else if (asRecord(item)) {
      Object.assign(enriched, item);
    }
  }

  const combined = messages.filter(Boolean).join('\n');
  const fromMessage = githubValidationBody(combined);
  const fromData = asRecord(enriched.data);
  const fromResponse = asRecord(enriched.response);
  const body = fromMessage ?? fromResponse ?? fromData;

  if (body) {
    if (Array.isArray(body.errors)) enriched.errors = body.errors;
    if (typeof body.message === 'string' && !fromMessage) {
      // Prefer the outer MCP wording when Details was parsed from it.
    } else if (typeof body.message === 'string' && !enriched.message) {
      enriched.message = body.message;
    }
    if (typeof body.documentation_url === 'string') {
      enriched.documentation_url = body.documentation_url;
    }
    if (typeof body.status === 'number') enriched.status = body.status;
  }

  if (typeof enriched.statusCode === 'number' && enriched.status === undefined) {
    enriched.status = enriched.statusCode;
  }

  // create_issue on the archived TS server strips errors[]; leave a fixable hint instead.
  if (
    !enriched.errors &&
    BARE_GITHUB_VALIDATION.test(combined) &&
    /Validation Failed/i.test(combined)
  ) {
    enriched.hint = BARE_VALIDATION_HINT;
  }

  if (combined && !enriched.message) enriched.message = combined;

  return enriched;
}

/** One line, redacted against this run's credentials, short enough for a chat bubble. */
export function reason(error: unknown, secrets: ReadonlySet<string>, limit = 300): string {
  const text =
    typeof error === 'string' ? error : error instanceof Error ? error.message : String(error);

  return redactText(text, secrets)
    .replace(CREDENTIAL_SHAPES, (match, _group, name?: string, joint?: string) =>
      name
        ? `${name}${joint}[REDACTED]`
        : /^bearer/i.test(match)
          ? 'Bearer [REDACTED]'
          : '[REDACTED]',
    )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

/**
 * What the model sees when a tool throws: structured validation fields when present, otherwise
 * a short redacted sentence. Keeps GitHub `errors[]` and documentation_url intact.
 */
export function toolFailure(error: unknown, secrets: ReadonlySet<string>): string {
  const enriched = enrichToolFailure(error);
  const stringLimit = enriched.errors || enriched.documentation_url || enriched.hint ? 2_000 : 200;

  const sanitize = (value: unknown, depth = 0): unknown => {
    if (typeof value === 'string') return reason(value, secrets, stringLimit);
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (depth >= 5) return undefined;
    if (Array.isArray(value)) return value.slice(0, 12).map((item) => sanitize(item, depth + 1));
    if (!value || typeof value !== 'object') return undefined;

    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => FAILURE_FIELDS.has(key))
        .slice(0, 16)
        .map(([key, item]) => [key, sanitize(item, depth + 1)])
        .filter(([, item]) => item !== undefined),
    );
  };

  const structured = sanitize(enriched);

  if (structured && typeof structured === 'object' && Object.keys(structured).length) {
    const encoded = JSON.stringify(structured);
    if (encoded.length <= 4_000) return encoded;

    const { message, origin, code, format, path, issues, errors, documentation_url, status, hint } =
      structured as Record<string, unknown>;
    const summary = { message, origin, code, format, path, status, documentation_url, hint };
    const concise = JSON.stringify({
      ...summary,
      errors: Array.isArray(errors) ? errors.slice(0, 6) : undefined,
      issues: Array.isArray(issues) ? issues.slice(0, 1) : undefined,
    });
    return concise.length <= 4_000 ? concise : JSON.stringify(summary);
  }

  return reason(error, secrets) || 'no reason given. Inspect saved steps before retrying.';
}
