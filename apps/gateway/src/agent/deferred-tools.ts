import type { ModelMessage, Tool, ToolSet } from 'ai';

/**
 * Loading tools on Claude without moving the cached prompt.
 *
 * Anthropic caches a request's prefix in the order `tools` → `system` → `messages`, so a tool
 * array that grows when the agent loads a group rewrites the whole prompt into the cache: one
 * long turn wrote 630k of its 924k cache tokens that way. On the models that think across steps
 * a changed tool set also drops the earlier thinking (`tool_set_changed`). On the models that
 * take it, every tool the run could load is sent on every step with `defer_loading`, which keeps
 * it out of the prefix, and a load answers with a `tool_reference` to each tool it brought in;
 * Anthropic expands a reference in place, so the tool joins the conversation, not the tool list.
 */

/**
 * Claude 4.5 and newer, and every 5.x, read `defer_loading` and `tool_reference`; Opus 4.1 and
 * older refuse them. The version is read from the id, as `takesAdaptiveThinking` does: a one or
 * two digit part after the major is the minor, a longer one a release date. An id that names no
 * version (a proxy's alias, a new family) keeps the tool list narrowed as before, on purpose: a
 * model that refused the deferred form would fail every turn, while the narrowed list only costs
 * cache. A model Anthropic already refused it for in this process is not offered it again.
 */
export function defersTools(provider: string, modelId: string): boolean {
  if (provider !== 'anthropic' || deferralRefused(modelId)) return false;
  const match = /claude-(?:opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2})(?!\d))?/.exec(modelId);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2] ?? 0);
  return major > 4 || (major === 4 && minor >= 5);
}

/**
 * The models Anthropic refused the deferred form for, by id, while this process runs: a later
 * run goes narrowed from its start rather than pay the refusal again. Kept in memory only, so a
 * restart tries again, as after an upgrade that may have fixed it.
 */
const refused = new Set<string>();

export const deferralRefused = (modelId: string) => refused.has(modelId);

export function refuseDeferral(modelId: string) {
  refused.add(modelId);
}

/** Anthropic refuses a request with more deferred tools than this. */
export const MAX_DEFERRED = 10_000;

type Output = Awaited<ReturnType<NonNullable<Tool['toModelOutput']>>>;
type Part = Extract<Output, { type: 'content' }>['value'][number];

const reference = (toolName: string): Part => ({
  type: 'custom',
  providerOptions: { anthropic: { type: 'tool-reference', toolName } },
});

const toolNameOf = (part: unknown): string | undefined => {
  const options = (part as { type?: string; providerOptions?: { anthropic?: unknown } })
    ?.providerOptions?.anthropic as { type?: unknown; toolName?: unknown } | undefined;
  return (part as { type?: string }).type === 'custom' &&
    options?.type === 'tool-reference' &&
    typeof options.toolName === 'string'
    ? options.toolName
    : undefined;
};

/** The tools the messages reference: what Anthropic will have expanded into the context. */
export function referencedTools(messages: readonly ModelMessage[]): Set<string> {
  const names = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'tool') continue;
    for (const part of message.content) {
      if (part.type !== 'tool-result' || part.output.type !== 'content') continue;
      for (const item of part.output.value) {
        const name = toolNameOf(item);
        if (name) names.add(name);
      }
    }
  }
  return names;
}

/** The prefix of the call ids `carriedLoads` makes up: no model or provider gives one like it. */
export const CARRIED = 'jian_carried_';

/**
 * What an earlier turn loaded, as a load call and its result made up for this turn. History is
 * replayed as text, so a tool loaded last turn has no reference left; sending it whole instead
 * would change the tools, the very front of the prompt, and the turn would read nothing back
 * from the cache. Placed after the history, the made-up call keeps the tools as the last turn
 * sent them. It is built once a turn and never stored.
 */
export function carriedLoads(input: {
  tools: readonly string[];
  groups: readonly string[];
  mcp: readonly string[];
}): ModelMessage[] {
  const loads = [
    ...(input.tools.length
      ? [
          {
            id: `${CARRIED}tools`,
            name: 'load_tools',
            input: { groups: input.groups },
            result: { loaded: input.tools },
            names: input.tools,
          },
        ]
      : []),
    ...(input.mcp.length
      ? [
          {
            id: `${CARRIED}mcp`,
            name: 'load_mcp_tools',
            input: { names: input.mcp },
            result: { selected: input.mcp },
            names: input.mcp,
          },
        ]
      : []),
  ];
  if (!loads.length) return [];
  return [
    {
      role: 'assistant',
      content: loads.map((load) => ({
        type: 'tool-call' as const,
        toolCallId: load.id,
        toolName: load.name,
        input: load.input,
      })),
    },
    {
      role: 'tool',
      content: loads.map((load) => ({
        type: 'tool-result' as const,
        toolCallId: load.id,
        toolName: load.name,
        output: {
          type: 'content' as const,
          value: [
            { type: 'text' as const, text: JSON.stringify(load.result) },
            ...load.names.map(reference),
          ],
        },
      })),
    },
  ];
}

type Loose = { role: string; content: unknown };

/**
 * The messages without what deferral added: tool references, and the loads `carriedLoads` made
 * up. Works on the SDK's messages and on the prompt a provider is handed alike. A request that
 * sends no tools must carry no reference, or Anthropic refuses it; tools let go of under window
 * pressure lose theirs so they leave the context, which is what letting go of them is for; and a
 * request Anthropic refused in this form is sent again without it. Messages with nothing to
 * remove are returned as they were; one left empty is dropped.
 */
export function withoutDeferral<M extends Loose>(messages: M[]): M[] {
  let changed = false;
  const next: M[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) {
      next.push(message);
      continue;
    }
    const parts = message.content as Array<Record<string, unknown>>;
    const kept = parts.flatMap((part) => {
      if (
        (part.type === 'tool-call' || part.type === 'tool-result') &&
        typeof part.toolCallId === 'string' &&
        part.toolCallId.startsWith(CARRIED)
      )
        return [];
      const output = part.type === 'tool-result' ? (part.output as Loose['content']) : undefined;
      const value = (output as { type?: string; value?: unknown } | undefined)?.value;
      if (
        (output as { type?: string } | undefined)?.type === 'content' &&
        Array.isArray(value) &&
        value.some((item) => toolNameOf(item) !== undefined)
      )
        return [
          {
            ...part,
            output: {
              ...(output as object),
              value: value.filter((item) => toolNameOf(item) === undefined),
            },
          },
        ];
      return [part];
    });
    if (kept.length === parts.length && kept.every((part, index) => part === parts[index])) {
      next.push(message);
      continue;
    }
    changed = true;
    if (kept.length) next.push({ ...message, content: kept });
  }
  return changed ? next : messages;
}

/** What the SDK makes of a result when the tool has no `toModelOutput` of its own. */
const plainOutput = (output: unknown): Output => {
  if (typeof output === 'string') return { type: 'text', value: output };
  // As the SDK's own `toJSONValue`: what JSON cannot say (undefined, a function) becomes null.
  const json = output === undefined ? undefined : JSON.stringify(output);
  return { type: 'json', value: json === undefined ? null : JSON.parse(json) };
};

/**
 * A tool's `toModelOutput` that adds a reference to each tool its call brought in, after what
 * the result already says. Added here, after the result was bounded and stored, the references
 * survive the result's own truncation and never reach the stored record or the owner's timeline.
 */
export function referencing(
  definition: Tool,
  broughtIn: (toolCallId: string) => readonly string[] | undefined,
): NonNullable<Tool['toModelOutput']> {
  const own = definition.toModelOutput;
  return async (options) => {
    const output: Output = own ? await own(options) : plainOutput(options.output);
    const names = broughtIn(options.toolCallId);
    if (!names?.length) return output;
    const refs = names.map(reference);
    switch (output.type) {
      case 'content':
        return { ...output, value: [...output.value, ...refs] };
      case 'text':
        return { type: 'content', value: [{ type: 'text', text: output.value }, ...refs] };
      case 'json':
        return {
          type: 'content',
          value: [{ type: 'text', text: JSON.stringify(output.value) }, ...refs],
        };
      default:
        return output;
    }
  };
}

/**
 * Marks the run's tools for this step: `deferred` ones with `defer_loading`, the rest as they
 * were built. The definitions are the run's own copies, read by the SDK as each step is sent.
 */
export function markDeferred(
  tools: ToolSet,
  deferred: ReadonlySet<string>,
  built: ReadonlyMap<string, Tool['providerOptions']>,
) {
  for (const [name, definition] of Object.entries(tools)) {
    const own = built.get(name);
    definition.providerOptions = deferred.has(name)
      ? { ...own, anthropic: { ...own?.anthropic, deferLoading: true } }
      : own;
  }
}
