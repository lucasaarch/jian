import {
  DECK_SLIDES_MAX,
  type RunProgress,
  SESSION_ARTIFACT_MAX,
  sessionArtifactTypeSchema,
} from '@jian/contracts';
import { parsePartialJson } from 'ai';

/**
 * The calls followed, and whether each revises an Artifact that exists. `edit_artifact` changes
 * one by a few replacements, which show nothing worth drawing on their own: its draft only names
 * the Artifact, so the panel can say it is being changed while the version in view stays.
 */
const TOOLS = new Map<string, 'create' | 'update' | 'edit'>([
  ['create_artifact', 'create'],
  ['update_artifact', 'update'],
  ['edit_artifact', 'edit'],
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Between two reads of what was written: parsing the whole text again is quadratic in its size. */
const EVERY = 250;
/** The tool's input in JSON, which escapes: a few times the source it may carry. */
const RAW_MAX = SESSION_ARTIFACT_MAX * 4;

/**
 * Follows the input of one `create_artifact`, `update_artifact` or `edit_artifact` call while the
 * model writes it, so the owner can watch the Artifact being made. What it hands out is a preview
 * for the run's progress, never a version: the tool that runs afterwards is what makes one.
 */
export class ArtifactDraft {
  private call?: {
    id: string;
    kind: 'create' | 'update' | 'edit';
    raw: string;
    readAt: number;
    /** An edit's draft was handed out: it says nothing more, so it is not read again. */
    named?: boolean;
  };

  constructor(private readonly clock: () => number = Date.now) {}

  start(id: string, toolName: string): void {
    const kind = TOOLS.get(toolName);
    this.call = kind ? { id, kind, raw: '', readAt: Number.NEGATIVE_INFINITY } : undefined;
  }

  /**
   * The draft so far, or undefined while it is not due, not this call's or not yet readable.
   * `force` reads it whatever the interval says: the end of the input must not wait.
   */
  async push(id: string, delta: string, force = false): Promise<RunProgress['artifact']> {
    const call = this.call;
    if (!call || call.id !== id || call.named) return undefined;
    // Past the bound the text stops growing, so a model that never stops costs no more memory.
    if (call.raw.length + delta.length <= RAW_MAX) call.raw += delta;
    if (!force && this.clock() - call.readAt < EVERY) return undefined;
    call.readAt = this.clock();

    const { value, state } = await parsePartialJson(call.raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const input = value as Record<string, unknown>;
    const target = typeof input.artifactId === 'string' ? input.artifactId : undefined;
    // A revision says which Artifact only once its id is whole: half of one names nothing.
    if (call.kind !== 'create' && !(target && UUID.test(target))) return undefined;
    const type = sessionArtifactTypeSchema.safeParse(input.type);
    const written = Array.isArray(input.slides)
      ? input.slides.filter((slide) => typeof slide === 'string')
      : undefined;
    const content =
      call.kind === 'edit'
        ? ''
        : written
          ? written.join('\n\n')
          : typeof input.content === 'string'
            ? input.content
            : '';
    const title = typeof input.title === 'string' ? input.title.trim().slice(0, 120) : '';

    if (call.kind === 'edit') call.named = true;

    return {
      toolCallId: id,
      ...(call.kind !== 'create' && target ? { artifactId: target } : {}),
      ...(title ? { title } : {}),
      ...(type.success ? { type: type.data } : {}),
      content: content.slice(0, SESSION_ARTIFACT_MAX),
      ...(written && call.kind !== 'edit' ? { slides: whole(written, state) } : {}),
    };
  }

  end(): void {
    this.call = undefined;
  }
}

/**
 * A deck's slides written in full so far. While the input is still being written, its last slide
 * is the one the model is on (the parser closes its string for it), so it is left out; once the
 * input parses whole, every slide is. Together they stay within one Artifact's bound, the most a
 * draft carries, so a deck being written costs the progress at most twice its `content`.
 */
function whole(slides: string[], state: string): string[] {
  const done = state === 'successful-parse' ? slides : slides.slice(0, -1);
  const kept: string[] = [];
  let size = 0;

  for (const slide of done.slice(0, DECK_SLIDES_MAX)) {
    size += slide.length;
    if (size > SESSION_ARTIFACT_MAX) break;
    kept.push(slide);
  }
  return kept;
}
