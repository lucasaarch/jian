'use client';

import { AnimatePresence, motion } from 'motion/react';
import { useState } from 'react';
import { useAppearance } from '../lib/appearance';
import { AgentFace } from './face';

/**
 * How wide a capital of the hero's black serif runs, as a share of its size: a word of n letters
 * is about n times this wide. Rounded up so the longest word keeps a margin either side.
 */
const LETTER = 0.78;
const settle = [0.23, 1, 0.32, 1] as const;

/** The font size that lets the longest word fill the column and no more. */
const sizeFor = (words: string[]) => {
  const longest = Math.max(1, ...words.map((word) => [...word].length));
  return `clamp(2.25rem, calc(100cqi / ${(longest * LETTER).toFixed(2)}), 7.5rem)`;
};

const heading =
  'max-w-full text-center font-hero font-black uppercase leading-[0.9] tracking-[0.01em] whitespace-pre-line [overflow-wrap:anywhere]';

/**
 * Where a new chat opens: the agent's face, its name set large in capitals, a word to a line,
 * and under it what the agent is for. The longest word decides the size — it fills the column's
 * width and no more — so a short name stands tall and a long one comes down to fit, never cut
 * and never small for no reason.
 */
export function AgentHero({
  name,
  avatar,
  summary,
  handoffId,
  blank,
}: {
  name: string;
  avatar?: string | null;
  summary?: string;
  /** Only the first-run hero shares its position across the Welcome and the new chat. */
  handoffId?: string;
  /** What a hero being written shows, dimmed, before anything is typed; it then follows each key. */
  blank?: { name: string; summary: string };
}) {
  const { still } = useAppearance();
  if (blank) return <LiveHero name={name} avatar={avatar} summary={summary} blank={blank} />;

  const Surface = handoffId ? motion.div : 'div';
  const words = name.trim().split(/\s+/);
  const shared = (part: string) =>
    handoffId
      ? {
          layoutId: `welcome-agent-${handoffId}-${part}`,
          layout: 'position' as const,
          transition: { layout: { duration: still ? 0 : 1.05, ease: settle } },
        }
      : {};

  return (
    <div className="flex w-full flex-col items-center gap-6 [container-type:inline-size]">
      <Surface {...shared('face')}>
        <AgentFace name={name} avatar={avatar} size={5} />
      </Surface>
      <Surface {...shared('identity')} className="grid max-w-full justify-items-center gap-3">
        <h2 className={`${heading} text-ink`} style={{ fontSize: sizeFor(words) }}>
          {words.join('\n')}
        </h2>
        <p className="max-w-md text-center text-sm leading-relaxed text-muted">
          {summary?.trim() || 'Ask anything, or hand over something to get done.'}
        </p>
      </Surface>
    </div>
  );
}

/**
 * The hero as it is being written. Each typed letter comes in out of a blur, the size eases as
 * the longest word grows, and the face and the line under the name cross over when they change
 * at once — a new picture, a pasted or chosen summary — rather than snapping. Typing a summary
 * key by key changes it in place: a crossfade per key would only flicker.
 */
function LiveHero({
  name,
  avatar,
  summary = '',
  blank,
}: {
  name: string;
  avatar?: string | null;
  summary?: string;
  blank: { name: string; summary: string };
}) {
  const { still } = useAppearance();
  const named = name.trim() !== '';
  const words = (named ? name : blank.name).trim().split(/\s+/);
  const line = summary.trim() || blank.summary;
  const version = useJumps(line);
  const fade = (blur: number) => ({
    initial: still ? false : { opacity: 0, filter: `blur(${blur}px)` },
    animate: { opacity: 1, filter: 'blur(0px)' },
    exit: { opacity: 0, filter: still ? 'blur(0px)' : `blur(${blur}px)` },
    transition: { duration: still ? 0 : 0.45, ease: settle },
  });

  // Letters are keyed by where they stand: a key typed at the end is the one that arrives.
  const letters: { key: string; text: string }[] = [];
  words.forEach((word, at) => {
    if (at > 0) letters.push({ key: `break-${at}`, text: '\n' });
    let index = 0;
    for (const letter of word) letters.push({ key: `${at}-${index++}`, text: letter });
  });

  return (
    <div className="flex w-full flex-col items-center gap-6 [container-type:inline-size]">
      <div className="grid *:col-start-1 *:row-start-1">
        <AnimatePresence initial={false}>
          <motion.div key={avatar ?? words[0]?.slice(0, 1).toLocaleUpperCase()} {...fade(6)}>
            <AgentFace name={words[0] ?? ''} avatar={avatar} size={5} />
          </motion.div>
        </AnimatePresence>
      </div>
      <div className="grid max-w-full justify-items-center gap-3">
        <div className="grid max-w-full justify-items-center *:col-start-1 *:row-start-1">
          <AnimatePresence initial={false}>
            <motion.h2
              key={named ? 'name' : 'blank'}
              {...fade(10)}
              className={`${heading} ${named ? 'text-ink' : 'text-ink/20'} ${still ? '' : 'transition-[font-size] duration-500 ease-[cubic-bezier(0.23,1,0.32,1)]'}`}
              style={{ fontSize: sizeFor(words) }}
            >
              {named
                ? letters.map((letter) =>
                    letter.text === '\n' ? (
                      letter.text
                    ) : (
                      <motion.span
                        key={letter.key}
                        initial={still ? false : { opacity: 0, filter: 'blur(12px)' }}
                        animate={{ opacity: 1, filter: 'blur(0px)' }}
                        transition={{ duration: 0.4, ease: settle }}
                      >
                        {letter.text}
                      </motion.span>
                    ),
                  )
                : words.join('\n')}
            </motion.h2>
          </AnimatePresence>
        </div>
        <div className="grid max-w-md justify-items-center *:col-start-1 *:row-start-1">
          <AnimatePresence initial={false}>
            <motion.p
              key={version}
              {...fade(6)}
              className="text-center text-sm leading-relaxed text-muted"
            >
              {line}
            </motion.p>
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}

/**
 * Counts the changes to a text that no single key could make: a paste, a chosen preset, a
 * cleared field. The count keys the crossfade, so typing leaves it alone.
 */
function useJumps(text: string): number {
  const [last, setLast] = useState(text);
  const [count, setCount] = useState(0);
  if (text !== last) {
    setLast(text);
    if (!byOneKey(last, text)) setCount(count + 1);
  }
  return count;
}

/** Whether `after` is `before` with at most one character typed or any run deleted. */
function byOneKey(before: string, after: string): boolean {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = 0;
  while (
    end < before.length - start &&
    end < after.length - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  )
    end++;
  const inserted = after.length - start - end;
  const removed = before.length - start - end;
  return inserted === 0 || (inserted === 1 && removed <= 1);
}
