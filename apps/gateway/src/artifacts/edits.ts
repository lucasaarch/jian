import { GatewayError } from '../core/errors.js';

/** Where `find` is, overlapping ones counted: "aa" in "aaa" is two, which is not one. */
function matches(source: string, find: string): number[] {
  const found: number[] = [];
  for (let at = source.indexOf(find); at !== -1; at = source.indexOf(find, at + 1)) {
    found.push(at);
  }
  return found;
}

/**
 * The source after each `find` was replaced by its `replace`, in order, each in the text the one
 * before left. All or nothing: one `find` that is missing, or is in more than one place, refuses
 * the whole call, saying which one and why, so the agent fixes that edit instead of guessing what
 * was applied. `where` names the text for the refusal ("the source", "slide 2").
 */
export function editedSource(
  source: string,
  edits: readonly { find: string; replace: string }[],
  where: string,
): string {
  let text = source;

  edits.forEach(({ find, replace }, index) => {
    const which = edits.length === 1 ? 'The edit' : `Edit ${index + 1} of ${edits.length}`;
    const found = matches(text, find);
    if (found.length === 0) {
      throw new GatewayError(
        400,
        `${which} matched nothing in ${where}${index > 0 ? ', as the edits before it left it' : ''}. Copy \`find\` exactly from read_artifact_source, spaces and line breaks included. Nothing was changed.`,
      );
    }
    if (found.length > 1) {
      throw new GatewayError(
        400,
        `${which} matched ${found.length} places in ${where}. Give \`find\` more of the text around the one you mean, so it matches only that. Nothing was changed.`,
      );
    }
    const at = found[0] as number;
    text = text.slice(0, at) + replace + text.slice(at + find.length);
  });

  if (text === source) {
    throw new GatewayError(400, `The edits leave ${where} as it was, so no version was made.`);
  }
  return text;
}
