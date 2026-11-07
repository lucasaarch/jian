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
 * version keeps the tool list narrowed as before.
 */
export function defersTools(provider: string, modelId: string): boolean {
  if (provider !== 'anthropic') return false;
  const match = /claude-(?:opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2})(?!\d))?/.exec(modelId);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2] ?? 0);
  return major > 4 || (major === 4 && minor >= 5);
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

/**
 * The messages without their tool references. A request that sends no tools must carry none, or
 * Anthropic refuses it; tools let go of under window pressure lose theirs so they leave the
 * context, which is what letting go of them is for. Messages with nothing to remove are
 * returned as they were.
 */
export function withoutReferences(messages: ModelMessage[]): ModelMessage[] {
  const drops = (part: unknown) => toolNameOf(part) !== undefined;
  let changed = false;
  const next = messages.map((message) => {
    if (message.role !== 'tool') return message;
    if (
      !message.content.some(
        (part) =>
          part.type === 'tool-result' &&
          part.output.type === 'content' &&
          part.output.value.some(drops),
      )
    )
      return message;
    changed = true;
    return {
      ...message,
      content: message.content.map((part) =>
        part.type === 'tool-result' && part.output.type === 'content'
          ? {
              ...part,
              output: { ...part.output, value: part.output.value.filter((item) => !drops(item)) },
            }
          : part,
      ),
    };
  });
  return changed ? next : messages;
}

/** What the SDK makes of a result when the tool has no `toModelOutput` of its own. */
const plainOutput = (output: unknown): Output =>
  typeof output === 'string'
    ? { type: 'text', value: output }
    : { type: 'json', value: output === undefined ? null : JSON.parse(JSON.stringify(output)) };

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
