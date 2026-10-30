import { common, createLowlight } from 'lowlight';

/** One highlighter for the panel: the file viewer, diffs, requests and code blocks share it. */
export const lowlight = createLowlight(common);

type Root = ReturnType<typeof lowlight.highlight>;
export type Node = Root['children'][number];

/**
 * Past this many characters code is shown without colours: the highlighter runs on the main
 * thread, and a multi-megabyte log would freeze the panel while it works.
 */
export const HIGHLIGHT_LIMIT = 200_000;

/** One piece of a highlighted line: its text and the classes highlight.js gave it. */
export type Segment = { text: string; className?: string };

/**
 * Text highlighted as a whole and handed back line by line, so a token spanning lines (a block
 * comment, a template string) keeps its colour on every line it covers. Plain segments when the
 * grammar is unknown or the text is huge.
 */
export function highlightLines(text: string, language?: string): Segment[][] {
  const lines: Segment[][] = [[]];

  if (!language || !lowlight.registered(language) || text.length > HIGHLIGHT_LIMIT) {
    return text.split('\n').map((line) => [{ text: line }]);
  }

  const walk = (nodes: Node[], classes: string[]) => {
    for (const node of nodes) {
      if (node.type === 'text') {
        const parts = node.value.split('\n');

        for (const [index, part] of parts.entries()) {
          if (index > 0) lines.push([]);
          if (part) {
            lines
              .at(-1)
              ?.push({ text: part, ...(classes.length ? { className: classes.join(' ') } : {}) });
          }
        }
      } else if (node.type === 'element') {
        const own = node.properties.className;
        walk(node.children as Node[], [...classes, ...(Array.isArray(own) ? own.map(String) : [])]);
      }
    }
  };

  walk(lowlight.highlight(language, text).children, []);

  return lines;
}
