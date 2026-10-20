/**
 * What is left to send on a channel after commentary already went out.
 *
 * The narrator releases finished paragraphs while the run is still working; `saySoFar` puts
 * those on the phone immediately. The run's final `output` can still restate them — a trailing
 * blank line, a closing recovery, or a joined restatement — and without this check the same
 * words leave again as the "answer", so WhatsApp shows a duplicate while the panel only stored
 * the overlap once as history.
 *
 * Returns `undefined` when every paragraph was already said. Otherwise returns the tail that
 * has not been flushed, preserving blank-line boundaries the phone still splits on.
 */
export function remainingOutbound(text: string, commentary: string[]): string | undefined {
  const answer = text.trim();

  if (!answer) {
    return undefined;
  }

  if (!commentary.length) {
    return answer;
  }

  if (commentary.at(-1) === answer) {
    return undefined;
  }

  let rest = answer;

  for (const said of commentary) {
    if (!said) {
      continue;
    }

    if (rest === said) {
      return undefined;
    }

    const prefix = `${said}\n\n`;

    if (!rest.startsWith(prefix)) {
      break;
    }

    rest = rest.slice(prefix.length);
  }

  const leftover = rest.trim();

  return leftover || undefined;
}
