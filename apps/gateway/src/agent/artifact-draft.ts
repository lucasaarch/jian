import { type RunProgress, SESSION_ARTIFACT_MAX, sessionArtifactTypeSchema } from '@jian/contracts';
import { parsePartialJson } from 'ai';

const TOOLS = new Set(['create_artifact', 'update_artifact']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Between two reads of what was written: parsing the whole text again is quadratic in its size. */
const EVERY = 250;
/** The tool's input in JSON, which escapes: a few times the source it may carry. */
const RAW_MAX = SESSION_ARTIFACT_MAX * 4;

/**
 * Follows the input of one `create_artifact` or `update_artifact` call while the model writes it,
 * so the owner can watch the Artifact grow. What it hands out is a preview for the run's progress,
 * never a version: the tool that runs afterwards is what makes one.
 */
export class ArtifactDraft {
  private call?: { id: string; update: boolean; raw: string; readAt: number };

  constructor(private readonly clock: () => number = Date.now) {}

  start(id: string, toolName: string): void {
    this.call = TOOLS.has(toolName)
      ? { id, update: toolName === 'update_artifact', raw: '', readAt: Number.NEGATIVE_INFINITY }
      : undefined;
  }

  /**
   * The draft so far, or undefined while it is not due, not this call's or not yet readable.
   * `force` reads it whatever the interval says: the end of the input must not wait.
   */
  async push(id: string, delta: string, force = false): Promise<RunProgress['artifact']> {
    const call = this.call;
    if (!call || call.id !== id) return undefined;
    // Past the bound the text stops growing, so a model that never stops costs no more memory.
    if (call.raw.length + delta.length <= RAW_MAX) call.raw += delta;
    if (!force && this.clock() - call.readAt < EVERY) return undefined;
    call.readAt = this.clock();

    const { value } = await parsePartialJson(call.raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const input = value as Record<string, unknown>;
    const target = typeof input.artifactId === 'string' ? input.artifactId : undefined;
    // A revision says which Artifact only once its id is whole: half of one names nothing.
    if (call.update && !(target && UUID.test(target))) return undefined;
    const type = sessionArtifactTypeSchema.safeParse(input.type);
    const content = Array.isArray(input.slides)
      ? input.slides.filter((slide) => typeof slide === 'string').join('\n\n')
      : typeof input.content === 'string'
        ? input.content
        : '';
    const title = typeof input.title === 'string' ? input.title.trim().slice(0, 120) : '';

    return {
      toolCallId: id,
      ...(call.update && target ? { artifactId: target } : {}),
      ...(title ? { title } : {}),
      ...(type.success ? { type: type.data } : {}),
      content: content.slice(0, SESSION_ARTIFACT_MAX),
    };
  }

  end(): void {
    this.call = undefined;
  }
}
