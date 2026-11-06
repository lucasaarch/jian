/**
 * Who an MCP server is signed in as, asked of the server itself. OAuth leaves no name behind: the
 * token says nothing a client may read. Most services offer a tool that answers it — `get_me`,
 * `whoami`, `atlassianUserInfo` — and its answer names the account, the way GitHub's login does.
 * Nothing here is required: a server with no such tool, or an answer with no name in it, leaves
 * the account unnamed.
 */

/** A tool as the MCP client lists it: what it is called and what it takes. */
type ListedTool = {
  inputSchema?: unknown;
  execute?: (input: Record<string, unknown>, options: never) => Promise<unknown> | unknown;
};

/**
 * The endings of a tool name that asks who is signed in, most telling first, compared without
 * case or separators. `getuser` comes last: it is often a lookup of anyone, answered for the
 * caller only when asked for "me".
 */
const ASKS_WHO = [
  'whoami',
  'getme',
  'getself',
  'currentuser',
  'authenticateduser',
  'userinfo',
  'getviewer',
  'accountinfo',
  'myprofile',
  'getuser',
];

/** An argument a "who is" tool may require, which every such tool reads "me" in. */
const ME_ARGUMENT = /^(query|id|user|user_?id|userid)$/i;

const plain = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

/** The arguments to ask with, or none when the tool requires something "me" cannot fill. */
function askingFor(schema: unknown): Record<string, unknown> | undefined {
  const required = (schema as { required?: unknown } | undefined)?.required;
  if (!Array.isArray(required) || required.length === 0) return {};
  const properties = ((schema as { properties?: Record<string, { type?: unknown }> }).properties ??
    {}) as Record<string, { type?: unknown }>;
  const input: Record<string, unknown> = {};
  for (const name of required) {
    if (typeof name !== 'string' || !ME_ARGUMENT.test(name)) return undefined;
    if (properties[name]?.type !== undefined && properties[name]?.type !== 'string')
      return undefined;
    input[name] = 'me';
  }
  return input;
}

/** The tool that says who is signed in, with what to ask it, if the server has one. */
export function whoTool(
  tools: Record<string, ListedTool>,
): { name: string; input: Record<string, unknown> } | undefined {
  for (const ending of ASKS_WHO) {
    for (const [name, tool] of Object.entries(tools)) {
      if (!tool.execute || !plain(name).endsWith(ending)) continue;
      const input = askingFor(
        (tool.inputSchema as { jsonSchema?: unknown } | undefined)?.jsonSchema ?? tool.inputSchema,
      );
      if (input) return { name, input };
    }
  }
  return undefined;
}

/** Fields that name an account, in the order a person would recognise it by. */
const NAMING = [
  'login',
  'username',
  'user_name',
  'userName',
  'handle',
  'preferred_username',
  'nickname',
  'email',
  'display_name',
  'displayName',
  'name',
];

/** What the tool answered, as data: its structured content, or the JSON its text holds. */
function answerOf(result: unknown): unknown {
  const structured = (result as { structuredContent?: unknown } | undefined)?.structuredContent;
  if (structured && typeof structured === 'object') return structured;
  const content = (result as { content?: unknown } | undefined)?.content;
  const text = Array.isArray(content)
    ? content
        .map((part) => (part as { type?: string; text?: string }).text ?? '')
        .join('\n')
        .trim()
    : typeof result === 'string'
      ? result
      : '';
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * The account an answer names. The fields are searched level by level, so the caller's own
 * `login` wins over the `name` of an organisation nested under it. An email gives its part before
 * the @: the address itself is not a name to show an agent.
 */
export function accountOf(result: unknown): string | undefined {
  const answer = answerOf(result);
  if (typeof answer === 'string') {
    return /(?:login|username|user)\s*[:=]\s*@?([\w.-]+)/i.exec(answer)?.[1];
  }
  let level: unknown[] = [answer];
  for (let depth = 0; depth < 4 && level.length; depth++) {
    for (const field of NAMING) {
      for (const node of level) {
        const value = (node as Record<string, unknown>)[field];
        if (typeof value === 'string' && value.trim()) {
          return field === 'email' ? value.split('@')[0] : value.trim();
        }
      }
    }
    level = level.flatMap((node) =>
      node && typeof node === 'object' ? Object.values(node as object) : [],
    );
  }
  return undefined;
}

/**
 * A server's name for an app's account: the app, then the account, within the 30 characters and
 * the letters a server name may use. Undefined when nothing of the account survives.
 */
export function accountServerName(app: string, account: string): string | undefined {
  const room = 30 - app.length - 1;
  const slug = account
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, room)
    .replace(/_+$/, '');
  return slug ? `${app}_${slug}` : undefined;
}

/** Asks the server who it is signed in as; nothing when it cannot say. */
export async function signedInAs(tools: Record<string, ListedTool>): Promise<string | undefined> {
  const who = whoTool(tools);
  const execute = who && tools[who.name]?.execute;
  if (!who || !execute) return undefined;
  try {
    const result = await Promise.race([
      execute(who.input, { toolCallId: 'jian-whoami', messages: [] } as never),
      new Promise((resolve) => setTimeout(resolve, 10_000).unref()),
    ]);
    return accountOf(result);
  } catch {
    return undefined;
  }
}
