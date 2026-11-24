import { redactText } from '../agent/results.js';

/**
 * Masks Secret values in a stream that arrives in arbitrary pieces. A terminal hands output over
 * as it reads it, so a value can be split across two pieces and match in neither: the end of a
 * piece that could still be the start of a value is held back until the next piece settles it.
 * Nothing else is held, so ordinary output is never delayed.
 */
export function streamMask(secrets: ReadonlySet<string>) {
  // The forms `redactText` masks, so the tail held back is judged by the same list.
  const variants = [
    ...new Set(
      [...secrets].flatMap((secret) =>
        secret ? [secret, JSON.stringify(secret).slice(1, -1)] : [],
      ),
    ),
  ];
  let held = '';

  /** The most characters at the end of `text` that are the start of some value. */
  const partial = (text: string) => {
    let most = 0;
    for (const variant of variants) {
      for (let size = Math.min(variant.length - 1, text.length); size > most; size -= 1) {
        if (text.endsWith(variant.slice(0, size))) {
          most = size;
          break;
        }
      }
    }
    return most;
  };

  return {
    /** What may be shown now of what was held and `data`; the rest waits for more. */
    push(data: string): string {
      const text = held + data;
      let cut = text.length - partial(text);

      // A whole value never straddles the cut: it is masked or held, not half shown.
      for (let moved = true; moved; ) {
        moved = false;
        for (const variant of variants) {
          for (let at = text.indexOf(variant); at !== -1; at = text.indexOf(variant, at + 1)) {
            if (at < cut && at + variant.length > cut) {
              cut = at;
              moved = true;
            }
          }
        }
      }

      held = text.slice(cut);
      return redactText(text.slice(0, cut), secrets);
    },
    /** The output has ended: what was held cannot become a value any more. */
    end(): string {
      const rest = held;
      held = '';
      return redactText(rest, secrets);
    },
  };
}
