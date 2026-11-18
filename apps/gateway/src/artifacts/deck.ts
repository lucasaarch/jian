import { DECK_MAX, DECK_SLIDES_MAX, deckContentSchema } from '@jian/contracts';
import { GatewayError } from '../core/errors.js';

/**
 * A deck is kept whole in each of its versions: its slides in order, in JSON, as that version's
 * content. Changing one slide therefore makes a version like any other, and going back to an
 * earlier one brings back every slide as it then was.
 */

/** One change to a deck's slides. Slides are counted from 1, as the agent and the owner count. */
export type SlideChange =
  | { op: 'add'; html: string; position?: number | undefined }
  | { op: 'update'; slide: number; html: string }
  | { op: 'delete'; slide: number }
  | { op: 'move'; slide: number; to: number };

/** The slides a version keeps. */
export const slidesOf = (content: string): string[] =>
  deckContentSchema.parse(JSON.parse(content)).slides;

/** What a version keeps for these slides, refused when there are too many or they are too big. */
export function deckContent(slides: readonly string[]): string {
  if (slides.length === 0) throw new GatewayError(400, 'A deck keeps at least one slide.');
  if (slides.length > DECK_SLIDES_MAX) {
    throw new GatewayError(400, `A deck holds at most ${DECK_SLIDES_MAX} slides.`);
  }
  const size = slides.reduce((sum, slide) => sum + slide.length, 0);
  if (size > DECK_MAX) {
    throw new GatewayError(
      400,
      `A deck's slides hold at most ${DECK_MAX.toLocaleString('en')} characters together, and these hold ${size.toLocaleString('en')}. Make its pictures smaller, or split it into two decks.`,
    );
  }

  return JSON.stringify({ slides });
}

const slideCount = (count: number) => (count === 1 ? '1 slide' : `${count} slides`);

/** The slides after one change, the given ones untouched. Says what the deck has when refused. */
export function changedSlides(slides: readonly string[], change: SlideChange): string[] {
  const next = [...slides];
  const held = (slide: number) => {
    if (slide > slides.length) {
      throw new GatewayError(
        400,
        `The deck has ${slideCount(slides.length)}, so there is no slide ${slide}.`,
      );
    }
    return slide - 1;
  };

  if (change.op === 'add') {
    const position = change.position ?? slides.length + 1;
    if (position > slides.length + 1) {
      throw new GatewayError(
        400,
        `The deck has ${slideCount(slides.length)}, so a new one goes at 1 to ${slides.length + 1}, not at ${position}.`,
      );
    }
    next.splice(position - 1, 0, change.html);
  } else if (change.op === 'update') {
    next[held(change.slide)] = change.html;
  } else if (change.op === 'delete') {
    if (slides.length === 1) {
      throw new GatewayError(
        400,
        'A deck keeps at least one slide. Write this one again with update_slide instead.',
      );
    }
    next.splice(held(change.slide), 1);
  } else {
    const from = held(change.slide);
    const [moved] = next.splice(from, 1);
    next.splice(held(change.to), 0, moved as string);
  }

  return next;
}
