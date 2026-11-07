import { type LanguageModel, type LanguageModelMiddleware, wrapLanguageModel } from 'ai';
import { CARRIED, refuseDeferral, withoutDeferral } from './deferred-tools.js';

type Params = Parameters<NonNullable<LanguageModelMiddleware['wrapStream']>>[0]['params'];

/**
 * Whether Anthropic refused a request for the deferred form itself. Its documentation shows a
 * `tool_result` holding only `tool_reference` blocks; Jian's carry text beside them, may carry a
 * cache mark, and a turn may open on a made-up load with no thinking before it. None of that has
 * been sent to Anthropic from here, so a 400 that names any of it is taken as that form refused.
 */
export function refusesDeferral(error: unknown, carried: boolean): boolean {
  const failure = error as { statusCode?: unknown; message?: unknown; responseBody?: unknown };
  if (failure?.statusCode !== 400) return false;
  const said = `${String(failure.message ?? '')} ${String(failure.responseBody ?? '')}`;
  return (
    /tool_reference|tool[ _-]?references?|defer_loading|deferred[ _-]?tools?/i.test(said) ||
    (carried && /thinking/i.test(said))
  );
}

const carries = (prompt: Params['prompt']) =>
  prompt.some(
    (message) =>
      Array.isArray(message.content) &&
      message.content.some(
        (part) =>
          'toolCallId' in part &&
          typeof part.toolCallId === 'string' &&
          part.toolCallId.startsWith(CARRIED),
      ),
  );

/** The same request as the runtime sent it before deferral: only the tools offered, none deferred. */
export function narrowedCall(params: Params, offered: ReadonlySet<string>): Params {
  return {
    ...params,
    ...(params.tools
      ? {
          tools: params.tools.flatMap((item): NonNullable<Params['tools']> => {
            if (item.type !== 'function') return [item];
            if (!offered.has(item.name)) return [];
            const anthropic = { ...item.providerOptions?.anthropic };
            delete anthropic.deferLoading;
            return [{ ...item, providerOptions: { ...item.providerOptions, anthropic } }];
          }),
        }
      : {}),
    prompt: withoutDeferral(params.prompt),
  };
}

/**
 * The run's model, sending a step Anthropic refused in the deferred form once more the old way.
 * The run carries on the old way (`refused`), and so does every later run on that model in this
 * process. Any other failure goes through as it was.
 */
export function withDeferralFallback(
  model: LanguageModel,
  options: {
    modelId: string;
    /** Whether this run still sends the deferred form. */
    active: () => boolean;
    /** The tools the run offers now, by its own bookkeeping. */
    offered: () => ReadonlySet<string>;
    refused: () => void;
  },
): LanguageModel {
  if (typeof model === 'string') return model;
  const fallBack = (error: unknown, params: Params) => {
    if (!options.active() || !refusesDeferral(error, carries(params.prompt))) throw error;
    refuseDeferral(options.modelId);
    options.refused();
    const said = String((error as { message?: unknown }).message ?? '').slice(0, 200);
    console.error(
      `jian: Anthropic refused deferred tools for ${options.modelId}; loading tools the old way — ${said}`,
    );
    return narrowedCall(params, options.offered());
  };
  return wrapLanguageModel({
    model,
    middleware: {
      specificationVersion: 'v4',
      wrapStream: async ({ doStream, params, model: inner }) => {
        try {
          return await doStream();
        } catch (error) {
          return inner.doStream(fallBack(error, params));
        }
      },
      wrapGenerate: async ({ doGenerate, params, model: inner }) => {
        try {
          return await doGenerate();
        } catch (error) {
          return inner.doGenerate(fallBack(error, params));
        }
      },
    },
  });
}
