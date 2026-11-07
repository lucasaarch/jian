import { StringDecoder } from 'node:string_decoder';

/**
 * Where output was dropped from the middle, with how much. The gateway reads this exact form
 * (its `agent/results.ts`) to tell the agent the output's real size, so it is a format between
 * the two, not wording: change both or neither.
 */
export function notKeptMarker(lines: number, characters: number): string {
  return `[… ${lines.toLocaleString('en')} lines (${characters.toLocaleString('en')} characters) of this output were not kept]`;
}

const NOT_KEPT = /\n?\[… ([\d,]+) lines \(([\d,]+) characters\) of this output were not kept\]\n?/;

const newlines = (text: string) => {
  let count = 0;
  for (let index = text.indexOf('\n'); index >= 0; index = text.indexOf('\n', index + 1)) count++;
  return count;
};

/** An index moved off the middle of a surrogate pair, so no half of a character is kept. */
function whole(text: string, index: number): number {
  const code = text.charCodeAt(index);
  return index > 0 && index < text.length && code >= 0xdc00 && code <= 0xdfff ? index + 1 : index;
}

/**
 * The first and last parts of a command's output, within `cap` characters. A build or a test
 * run says what failed at its end, so keeping only the start lost exactly what was needed.
 */
export class OutputEnds {
  private head = '';
  private tail = '';
  private lostLines = 0;
  private lostCharacters = 0;
  private readonly decoder = new StringDecoder('utf8');
  /** Room for each end; the marker between them is kept out of it. */
  private readonly half: number;

  constructor(cap: number) {
    this.half = Math.floor((cap - 120) / 2);
  }

  push(chunk: string | Buffer): void {
    // Decoded across chunks: a character split between two reads is put back together.
    let text = typeof chunk === 'string' ? chunk : this.decoder.write(chunk);
    if (this.head.length < this.half) {
      const room = whole(text, Math.min(text.length, this.half - this.head.length));
      this.head += text.slice(0, room);
      text = text.slice(room);
    }
    if (!text) return;
    this.tail += text;
    if (this.tail.length > this.half) {
      const from = whole(this.tail, this.tail.length - this.half);
      const dropped = this.tail.slice(0, from);
      this.lostLines += newlines(dropped);
      this.lostCharacters += dropped.length;
      this.tail = this.tail.slice(from);
    }
  }

  text(): string {
    this.push(this.decoder.end());
    return this.lostCharacters
      ? `${this.head}\n${notKeptMarker(this.lostLines, this.lostCharacters)}\n${this.tail}`
      : this.head + this.tail;
  }
}

/**
 * The same text within `room` characters, its first and last parts kept. A marker already in
 * it is folded into the new one, so what it says it lost stays the whole of what was lost.
 */
export function keepEnds(text: string, room: number): string {
  if (text.length <= room) return text;
  const found = NOT_KEPT.exec(text);
  let lines = 0;
  let characters = 0;
  let head: string;
  let tail: string;
  if (found) {
    lines = Number((found[1] ?? '0').replaceAll(',', ''));
    characters = Number((found[2] ?? '0').replaceAll(',', ''));
    head = text.slice(0, found.index);
    tail = text.slice(found.index + found[0].length);
  } else {
    const middle = whole(text, Math.floor(text.length / 2));
    head = text.slice(0, middle);
    tail = text.slice(middle);
  }
  const keep = Math.max(0, room - 120);
  let keptHead = Math.min(head.length, Math.ceil(keep / 2));
  const keptTail = Math.min(tail.length, keep - keptHead);
  keptHead = Math.min(head.length, keep - keptTail);
  const headEnd = whole(head, keptHead);
  const tailStart = whole(tail, tail.length - keptTail);
  const dropped = head.slice(headEnd) + tail.slice(0, tailStart);
  lines += newlines(dropped);
  characters += dropped.length;
  return `${head.slice(0, headEnd)}\n${notKeptMarker(lines, characters)}\n${tail.slice(tailStart)}`;
}
