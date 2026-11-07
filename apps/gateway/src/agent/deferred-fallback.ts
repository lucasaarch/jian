import { type LanguageModel, type LanguageModelMiddleware, wrapLanguageModel } from 'ai';
import { additionsOf, forget, withoutAdditions, withoutDeferral } from './deferred-tools.js';

type Params = Parameters<NonNullable<LanguageModelMiddleware['wrapStream']>>[0]['params'];
type Form = 'deferral' | 'carry';

/**
 * Which form Anthropic refused, if a refusal was of one at all. None of it has been sent to
 * Anthropic from here: its documentation shows a `tool_result` holding only `tool_reference`
 * blocks, and Jian's carry text beside them and may carry a cache mark; the tool additions are a
 * beta. A 400 that names the tool changes, when the request carried some, is the carry refused;
 * one that names references or deferred tools is the deferred form refused.
 */
export function refusedForm(error: unknown, carried: boolean): Form | undefined {
  const failure = error as { statusCode?: unknown; message?: unknown; responseBody?: unknown };
  if (failure?.statusCode !== 400) return undefined;
  const said = `${String(failure.message ?? '')} ${String(failure.responseBody ?? '')}`;
  if (
    carried &&
    /tool_addition|tool[ _-]?changes?|toolChanges|mid[ _-]?conversation|system message/i.test(said)
  )
    return 'carry';
  if (/tool_reference|tool[ _-]?references?|defer_loading|deferred[ _-]?tools?/i.test(said))
    return 'deferral';
  return undefined;
}

/** The request's tools, keeping those `keep` names and sending those `whole` names undeferred. */
const tools = (params: Params, keep: (name: string) => boolean, whole: (name: string) => boolean) =>
  params.tools?.flatMap((item): NonNullable<Params['tools']> => {
    if (item.type !== 'function') return [item];
    if (!keep(item.name)) return [];
    if (!whole(item.name)) return [item];
    const anthropic = { ...item.providerOptions?.anthropic };
    delete anthropic.deferLoading;
    return [{ ...item, providerOptions: { ...item.providerOptions, anthropic } }];
  });

/**
 * The same request without the refused form. Without the deferred form it is the request before
 * deferral: only the tools offered, none deferred, no references. Without the carry, the tools
 * the additions brought are sent whole instead, and the rest stays deferred.
 */
export function narrowedCall(params: Params, form: Form, offered: ReadonlySet<string>): Params {
  if (form === 'deferral') {
    return {
      ...params,
      ...(params.tools
        ? {
            tools: tools(
              params,
              (name) => offered.has(name),
              () => true,
            ),
          }
        : {}),
      prompt: withoutDeferral(params.prompt),
    };
  }
  const added = new Set(params.prompt.flatMap((message) => additionsOf(message) ?? []));
  return {
    ...params,
    ...(params.tools
      ? {
          tools: tools(
            params,
            () => true,
            (name) => added.has(name),
          ),
        }
      : {}),
    prompt: withoutAdditions(params.prompt),
  };
}

/**
 * The run's model, sending a step Anthropic refused in the deferred form, or with the carried
 * tool additions, once more without it. Only once that retry is answered is the refusal believed:
 * the run carries on without that form (`refused`), and so does every later run on that model in
 * this process. A retry that fails too reports the first failure and changes nothing. Any other
 * failure goes through as it was.
 */
export function withDeferralFallback(
  model: LanguageModel,
  options: {
    modelId: string;
    /** Whether this run still sends the deferred form. */
    active: () => boolean;
    /** The tools the run offers now, by its own bookkeeping. */
    offered: () => ReadonlySet<string>;
    refused: (form: Form) => void;
  },
): LanguageModel {
  if (typeof model === 'string') return model;
  const retried = async <T>(
    error: unknown,
    params: Params,
    send: (params: Params) => PromiseLike<T>,
  ): Promise<T> => {
    const carried = params.prompt.some((message) => additionsOf(message) !== undefined);
    const form = options.active() ? refusedForm(error, carried) : undefined;
    if (!form) throw error;
    let answer: T;
    try {
      answer = await send(narrowedCall(params, form, options.offered()));
    } catch {
      throw error;
    }
    forget(form, options.modelId);
    options.refused(form);
    const said = String((error as { message?: unknown }).message ?? '').slice(0, 200);
    const what = form === 'carry' ? 'carried tool additions' : 'deferred tools';
    console.error(
      `jian: Anthropic refused ${what} for ${options.modelId}; going on without them — ${said}`,
    );
    return answer;
  };
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: 'v4',
      wrapStream: async ({ doStream, params, model: inner }) => {
        try {
          return await doStream();
        } catch (error) {
          return retried(error, params, (next) => inner.doStream(next));
        }
      },
      wrapGenerate: async ({ doGenerate, params, model: inner }) => {
        try {
          return await doGenerate();
        } catch (error) {
          return retried(error, params, (next) => inner.doGenerate(next));
        }
      },
    },
  });
}
