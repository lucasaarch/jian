import { ARTIFACT_EDIT_MESSAGE, SESSION_ARTIFACT_MAX } from '@jian/contracts';

/**
 * Taking back what the owner edited by hand in a sealed frame. This is the one place the panel
 * reads anything a frame says, so it reads as little as it can:
 *
 * - It listens for answers only while it waits for one it asked for, and stops the moment it has
 *   it. The one other thing it hears, while a page is open for editing, is that something changed
 *   (`editChanged`): a fact with no content, which only makes it ask sooner.
 * - It hears only the window of the frame it asked, and only an answer carrying the random word
 *   it sent with the question.
 * - The answer is markup, as text, no longer than a page may be. It is never run, never drawn
 *   in the panel and never trusted: the caller sends it to the gateway with the owner's own
 *   credential, where it becomes one more version that is drawn sealed like any other.
 *
 * The frame is given nothing for it: no credential, no address, nothing of the panel.
 */

/** How long a frame has to answer, in milliseconds. It answers at once or not at all. */
const ANSWER_WITHIN = 4000;

export type EditAnswer = { html: string } | { unchanged: true } | { refused: string };

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;

/**
 * What a message comes to as the answer to the question asked with `nonce`. Nothing for a message
 * that is not that answer, which is then left alone; `refused` for an answer that cannot be kept.
 */
export function editAnswer(data: unknown, nonce: string): EditAnswer | undefined {
  const said = record(record(data)?.[ARTIFACT_EDIT_MESSAGE]);
  if (!said || said.collect !== nonce) return undefined;
  if (said.unchanged === true) return { unchanged: true };

  const { html } = said;
  if (typeof html !== 'string' || html.trim() === '') {
    return { refused: 'The page handed back nothing to save.' };
  }
  if (html.length > SESSION_ARTIFACT_MAX) {
    return {
      refused: `The edited page is too large to save: ${html.length.toLocaleString('en')} characters, and a page holds at most ${SESSION_ARTIFACT_MAX.toLocaleString('en')}.`,
    };
  }

  return { html };
}

/** Whether a message says the page was changed. It carries nothing else, and is read as only that. */
export const editChanged = (data: unknown): boolean =>
  record(record(data)?.[ARTIFACT_EDIT_MESSAGE])?.changed === true;

/**
 * Asks the frame the owner is editing in for the page as it now stands. Answers the markup, or
 * null when nothing was edited; refuses when the frame does not answer in time, or answers
 * something that cannot be kept.
 */
export function collectEdit(
  frame: HTMLIFrameElement | null,
  within = ANSWER_WITHIN,
): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const target = frame?.contentWindow;
    if (!target) {
      reject(new Error('The page is not open for editing.'));
      return;
    }
    const nonce = crypto.randomUUID();
    const settle = () => {
      clearTimeout(timer);
      window.removeEventListener('message', hear);
    };
    const hear = (event: MessageEvent) => {
      if (event.source !== target) return;
      const answer = editAnswer(event.data, nonce);
      if (!answer) return;
      settle();
      if ('refused' in answer) reject(new Error(answer.refused));
      else resolve('html' in answer ? answer.html : null);
    };
    const timer = setTimeout(() => {
      settle();
      reject(new Error('The page did not answer. It will be tried again.'));
    }, within);

    window.addEventListener('message', hear);
    // A sealed frame's origin cannot be named, so the target is `*`. The question holds nothing
    // but the word its answer must repeat.
    target.postMessage({ [ARTIFACT_EDIT_MESSAGE]: { collect: nonce } }, '*');
  });
}
