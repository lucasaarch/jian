---
name: ui-components
description: Use when adding or changing a UI file in packages/ui, or when a file nears 600 lines. No UI file passes 600 lines, and each piece does one thing, so a screen stays light and easy to read.
---

# UI components

No file in `packages/ui/src` (`.ts`, `.tsx` or `.css`, tests aside) passes 600 lines. The limit is a
ceiling, not a target: most files should be far below it.

## Rules

1. **One purpose per file.** A big file mixes state, reads and drawing, and nobody can change one
   without reading the others. A file you cannot name in a few words is two files.
2. **State and reads in stores and hooks, the shape of what to draw in pure functions, drawing in
   components.** Pure functions are tested without a render. A component that only draws is cheap
   to read and to redraw.
3. **A growing area becomes a folder with an entry file.** The entry keeps the old path and exports,
   so the callers do not change. Everything else is imported by relative path inside the folder.
4. **What updates often lives apart from what hardly changes.** A component that follows a stream
   redraws on every chunk. If it also holds the header, the toolbar and the list around it, all of
   those redraw for nothing. Give the fast part its own component, store slice or selector.
5. **Hidden content is not mounted.** A closed tool call, a collapsed section or a tab out of view
   costs CPU every time its parent renders, and nobody sees it. Build the body only while it is
   open, and keep the closed state cheap.
6. **CSS follows the same limit.** Split a stylesheet by surface, import the parts from
   `styles/index.css` in the original order so the cascade does not change, and repeat the
   `@reference` lines each part needs for `@apply`.

## The worked example

`packages/ui/src/components/sessions/conversation/` is the conversation history, once a single file
of more than a thousand lines:

| Piece | Files | Job |
|---|---|---|
| Store | `store.ts` | The messages, the live turn and the flags, with selectors |
| Reader | `reader.ts`, `use-history.ts` | Reads from the gateway, one at a time, and the earlier pages |
| Events | `events.ts` | Turns stream events into store changes and reads |
| Rows | `rows.ts`, `rows-live.ts`, `turns.ts` | Pure: from messages and tools to the list of rows |
| Row | `row.tsx`, `agent-line.tsx`, `work.tsx` | Draws one row |
| Live answer | `live-answer.tsx`, `live-text.ts`, `use-smooth-text.ts` | The part that updates on every chunk, and the text held until its message lands |
| Entry | `history.tsx` | Assembles the pieces; its props are the public surface |

Copy that split before adding to a big file.

## When a file nears the limit

1. Find the seams: what is state, what is a read, what is shape, what is drawing.
2. Move the pure parts out first, with their tests. Then the components.
3. Keep behavior identical in the same change. A split is not the place to fix things.
4. Check the limit:

```bash
find packages/ui/src \( -name '*.ts' -o -name '*.tsx' -o -name '*.css' \) ! -name '*.test.*' \
  | xargs wc -l | awk '$1>600'
```

Only the total line should print.
