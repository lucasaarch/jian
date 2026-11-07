import type { Run } from '@jian/contracts';
import { tokenCounter } from '../context/budget.js';
import { defaultScale } from '../context/scale.js';
import type { RuntimeOptions } from './types.js';

/**
 * Sizes in the provider's tokens, as the result budget is written: the gateway's estimate times
 * the run's scale (`context/scale.ts`), rounded up. Counted as bytes, Claude's 12,000 held about
 * 5,000 of its tokens, and the agent paged with read_artifact what would have fit, each page a
 * step that sends the whole prompt again. With no scale given, the provider's default, which is
 * above anything measured, so a result is only ever cut early, never let in too large.
 */
function resultTokens(run: Run, scale?: number) {
  const model = run.model ?? run.profile.model;
  const estimate = tokenCounter(model.provider, model.modelId);
  const by = scale ?? defaultScale(model.provider);
  return { count: (text: string) => Math.ceil(estimate(text) * by), scale: by };
}

// Replace longer secrets first so an overlapping shorter value cannot leave a suffix exposed.
export function redactText(text: string, secrets: ReadonlySet<string>): string {
  let result = text;

  const variants = [...secrets].flatMap((secret) =>
    secret ? [secret, JSON.stringify(secret).slice(1, -1)] : [],
  );

  for (const variant of [...new Set(variants)].sort((a, b) => b.length - a.length)) {
    result = result.replaceAll(variant, '[REDACTED]');
  }

  return result;
}

export function redactOutput(output: unknown, secrets: ReadonlySet<string>): unknown {
  let normalized: unknown;

  try {
    normalized = JSON.parse(JSON.stringify(output) ?? 'null');
  } catch {
    return '[Unserializable tool result]';
  }

  const visit = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return redactText(value, secrets);
    }

    if (Array.isArray(value)) {
      return value.map(visit);
    }

    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [redactText(key, secrets), visit(item)]),
      );
    }

    return value;
  };

  return visit(normalized);
}

/** MCP often wraps structured data in a text block; keep one representation for paging. */
function structuredMcpResult(output: unknown): unknown {
  if (!output || typeof output !== 'object') return output;
  const result = output as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
  if (result.content?.length !== 1 || result.content[0]?.type !== 'text') return output;
  try {
    const data: unknown = JSON.parse(result.content[0].text ?? '');
    if (!data || typeof data !== 'object') return output;
    const { content: _, ...rest } = result;
    return { ...rest, data };
  } catch {
    return output;
  }
}

/** Fit the serialized page, including escaped quotes and its cursor, rather than guessing chars. */
export function artifactPage(
  content: string,
  offset: number,
  limit: number,
  run: Run,
  artifactId?: string,
  /** The run's scale; the page must pass `boundToolResult` counted the same way. */
  scale?: number,
) {
  if (offset > content.length) throw new Error('Artifact offset is beyond the end of the result');
  const { count } = resultTokens(run, scale);
  const budget = (run.contextPolicy ?? run.profile.contextPolicy).toolResultTokens;
  const metadata: { artifactId?: string; totalCharacters?: number; instruction?: string } =
    artifactId
      ? {
          artifactId,
          totalCharacters: content.length,
          instruction:
            'Read every page with read_artifact at nextOffset until null before reviewing. Full output is preserved.',
        }
      : {};
  const page = (size: number) => ({
    ...metadata,
    content: content.slice(offset, offset + size),
    nextOffset: offset + size < content.length ? offset + size : null,
  });
  // Tiny result budgets still need a usable cursor, rather than an endlessly empty page.
  if (count(JSON.stringify(page(1))) > budget) delete metadata.instruction;
  if (count(JSON.stringify(page(1))) > budget) delete metadata.totalCharacters;
  let low = 0;
  let high = Math.max(0, Math.min(limit, content.length - offset));
  while (low < high) {
    const size = Math.ceil((low + high) / 2);
    if (count(JSON.stringify(page(size))) <= budget) low = size;
    else high = size - 1;
  }
  return page(low);
}

/** Keep the beginning and outcome of long local reads; the artifact retains every byte. */
function concisePreview(output: unknown, toolName: string, size: number): string | undefined {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return undefined;
  const data = output as Record<string, unknown>;
  const clip = (value: string, count: number) => {
    if (value.length <= count) return value;
    const head = Math.ceil(count / 2);
    const tail = count - head;
    return `${value.slice(0, head)}\n[${value.length - count} characters omitted; read artifact for full output]\n${tail ? value.slice(-tail) : ''}`;
  };

  if (
    toolName === 'run_command' &&
    typeof data.stdout === 'string' &&
    typeof data.stderr === 'string'
  ) {
    const failed = data.exitCode !== 0;
    return JSON.stringify({
      exitCode: data.exitCode,
      stderr: clip(data.stderr, failed ? size : Math.floor(size / 4)),
      stdout: clip(data.stdout, failed ? Math.floor(size / 4) : size),
    });
  }
  if (toolName === 'read_file' && typeof data.content === 'string') {
    return JSON.stringify({ ...data, content: clip(data.content, size) });
  }
  if (toolName === 'search_files' && typeof data.matches === 'string') {
    return JSON.stringify({ ...data, matches: clip(data.matches, size) });
  }
  return undefined;
}

export async function boundToolResult(
  output: unknown,
  toolName: string,
  run: Run,
  secrets: ReadonlySet<string>,
  options: Pick<RuntimeOptions, 'storeArtifact'>,
  concise = false,
  /** Provider tokens per token of the estimate, as the run measured it (`context/scale.ts`). */
  scale?: number,
): Promise<unknown> {
  const sanitized = redactOutput(
    toolName.startsWith('mcp__') ? structuredMcpResult(output) : output,
    secrets,
  );
  const json = JSON.stringify(sanitized) ?? 'null';
  const { count, scale: by } = resultTokens(run, scale);
  const limit = (run.contextPolicy ?? run.profile.contextPolicy).toolResultTokens;

  if (count(json) <= limit) {
    return sanitized;
  }

  let artifact: { artifactId: string; bytes: number } | undefined;

  try {
    artifact = await options.storeArtifact?.(run, toolName, sanitized);
  } catch {
    // Tool execution already happened. Keep a bounded preview rather than retrying the effect.
  }

  if (artifact && toolName.startsWith('mcp__')) {
    return artifactPage(json, 0, json.length, run, artifact.artifactId, scale);
  }

  // Characters, started at what the budget holds at this scale and halved until it fits.
  let previewSize = Math.min(json.length, Math.floor(limit / by));
  const previewAt = (size: number) =>
    (concise && artifact ? concisePreview(sanitized, toolName, size) : undefined) ??
    json.slice(0, size);
  let preview = previewAt(previewSize);

  let result = {
    truncated: true,
    preview,
    artifactId: artifact?.artifactId,
    bytes: Buffer.byteLength(json),
    ...(!artifact
      ? {
          incomplete: true,
          error:
            'The full output could not be saved. This preview is incomplete. Do not treat it as the full result or repeat a mutating call; narrow or paginate a read request instead.',
        }
      : {}),
  };

  while (previewSize > 0 && count(JSON.stringify(result)) > limit) {
    previewSize = Math.floor(previewSize / 2);
    preview = previewAt(previewSize);
    result = { ...result, preview };
  }

  if (count(JSON.stringify(result)) > limit) {
    throw new Error('Tool result budget exceeded');
  }

  return result;
}
