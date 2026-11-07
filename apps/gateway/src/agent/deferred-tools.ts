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

const claudeVersion = (modelId: string) => {
  const match = /claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2})(?!\d))?/.exec(modelId);
  return match
    ? { family: match[1] as string, version: Number(match[2]) + Number(match[3] ?? 0) / 10 }
    : undefined;
};

/**
 * Claude 4.5 and newer, and every 5.x, read `defer_loading` and `tool_reference`; Opus 4.1 and
 * older refuse them. The version is read from the id, as `takesAdaptiveThinking` does: a one or
 * two digit part after the major is the minor, a longer one a release date. An id that names no
 * version (a proxy's alias, a new family) keeps the tool list narrowed as before, on purpose: a
 * model that refused the deferred form would fail every turn, while the narrowed list only costs
 * cache. A model Anthropic already refused it for in this process is not offered it again.
 */
export function defersTools(provider: string, modelId: string): boolean {
  if (provider !== 'anthropic' || refused.has(modelId)) return false;
  const claude = claudeVersion(modelId);
  return claude !== undefined && claude.version >= 4.5;
}

/**
 * The models that take tool changes in a system message mid-conversation: Opus 4.8 and newer,
 * Sonnet 5.5 and newer, Fable and Mythos 5 and newer. Not Haiku, Sonnet 5 or anything 4.6 and
 * older. A model Anthropic refused them for in this process is not offered them again.
 */
export function carriesTools(modelId: string): boolean {
  const claude = claudeVersion(modelId);
  if (!claude || uncarried.has(modelId)) return false;
  const from: Record<string, number> = { opus: 4.8, sonnet: 5.5, fable: 5, mythos: 5 };
  const least = from[claude.family];
  return least !== undefined && claude.version >= least;
}

/**
 * The models Anthropic refused the deferred form (`refused`) or the carried tool changes
 * (`uncarried`) for, by id, while this process runs: a later run starts without what was
 * refused rather than pay the refusal again. Kept in memory only, so a restart tries again, as
 * after an upgrade that may have fixed it.
 */
const refused = new Set<string>();
const uncarried = new Set<string>();

export function forget(form: 'deferral' | 'carry', modelId: string) {
  (form === 'deferral' ? refused : uncarried).add(modelId);
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

type Loose = { role: string; content: unknown; providerOptions?: unknown };

/** The tools a system message adds mid-conversation; undefined for any other message. */
export function additionsOf(message: Loose): string[] | undefined {
  if (message.role !== 'system') return undefined;
  const changes = (message.providerOptions as { anthropic?: { toolChanges?: unknown } } | undefined)
    ?.anthropic?.toolChanges;
  if (!Array.isArray(changes)) return undefined;
  return changes.flatMap((change: { type?: unknown; toolName?: unknown }) =>
    change?.type === 'tool_addition' && typeof change.toolName === 'string'
      ? [change.toolName]
      : [],
  );
}

/**
 * The tools the messages bring into the context: a `tool_reference` in a tool result, or a
 * `tool_addition` in a system message. Anthropic expands both in place.
 */
export function referencedTools(messages: readonly ModelMessage[]): Set<string> {
  const names = new Set<string>();
  for (const message of messages) {
    for (const name of additionsOf(message) ?? []) names.add(name);
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
 * What an earlier turn loaded, added back at the end of this turn's first request by a system
 * message, as Anthropic lets the models of `carriesTools` change their tools mid-conversation.
 * History is replayed as text, so a tool loaded last turn has no reference left; sending it whole
 * instead would change the tools, the very front of the prompt, and the turn would read nothing
 * back from the cache. Anthropic takes such a message only right before an assistant message or
 * at the end: kept where it is, it sits before the first reply on every later step. Built once a
 * turn, after the history the cache marks, and never stored. It says nothing in text: the SDK
 * then sends only the additions.
 */
export function toolAdditions(names: readonly string[]): ModelMessage {
  return {
    role: 'system',
    content: '',
    providerOptions: {
      anthropic: {
        toolChanges: names.map((toolName) => ({ type: 'tool_addition', toolName })),
      },
    },
  };
}

/**
 * The messages without the tool additions of `toolAdditions`. A request Anthropic refused them
 * in is sent again without; the tools they added are then sent whole.
 */
export function withoutAdditions<M extends Loose>(messages: M[]): M[] {
  const kept = messages.filter((message) => additionsOf(message) === undefined);
  return kept.length === messages.length ? messages : kept;
}

/**
 * The messages without what deferral added: tool references and tool additions. Works on the
 * SDK's messages and on the prompt a provider is handed alike. A request that sends no tools must
 * carry neither, or Anthropic refuses it; tools let go of under window pressure lose theirs so
 * they leave the context, which is what letting go of them is for; and a request Anthropic
 * refused in this form is sent again without it. Messages with nothing to remove are returned as
 * they were.
 */
export function withoutDeferral<M extends Loose>(messages: M[]): M[] {
  let changed = false;
  const next = withoutAdditions(messages).map((message) => {
    if (!Array.isArray(message.content)) return message;
    const parts = message.content as Array<Record<string, unknown>>;
    if (
      !parts.some((part) => {
        const output = part.output as { type?: string; value?: unknown } | undefined;
        return (
          part.type === 'tool-result' &&
          output?.type === 'content' &&
          Array.isArray(output.value) &&
          output.value.some((item) => toolNameOf(item) !== undefined)
        );
      })
    )
      return message;
    changed = true;
    return {
      ...message,
      content: parts.map((part) => {
        const output = part.output as { type?: string; value?: unknown } | undefined;
        return part.type === 'tool-result' &&
          output?.type === 'content' &&
          Array.isArray(output.value)
          ? {
              ...part,
              output: {
                ...output,
                value: output.value.filter((item) => toolNameOf(item) === undefined),
              },
            }
          : part;
      }),
    };
  });
  return changed || next.length !== messages.length ? next : messages;
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
