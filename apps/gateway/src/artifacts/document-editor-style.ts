/**
 * What the document editor adds to the frame's own style (frame-style.ts) while the owner writes.
 * Nothing here moves the text: the column, the type and the rhythm stay the reading page's, so a
 * document looks the same written as read. The editor's own pieces (the bar of formatting, the
 * menu of blocks, the handle beside a block) float over the page in the panel's glass, with the
 * panel's ink and muted greys in both themes, since a frame cannot read the panel's tokens.
 *
 * `light-dark()` follows the frame's `color-scheme`, which the panel's theme sets.
 */
export const DOCUMENT_EDITOR_STYLE = `
#root[contenteditable] { outline: none; caret-color: CanvasText; }
#root ::selection { background: light-dark(rgba(35, 131, 226, .2), rgba(96, 160, 245, .32)); }
#root > div:not([class]) { margin: 0 0 1.1em; }
#root a { cursor: text; }
#root li > input[type=checkbox] { cursor: pointer; }
#root :is(th, td) { min-width: 3em; }
#root img { cursor: default; }
#root [data-jian-hint]::before { content: attr(data-jian-hint); float: left; height: 0;
  pointer-events: none; color: color-mix(in srgb, CanvasText 34%, transparent); }
#root li:has(> input[type=checkbox])[data-jian-hint]::before { content: none; }
#root li:has(> input[type=checkbox])[data-jian-hint]::after { content: attr(data-jian-hint);
  pointer-events: none; color: color-mix(in srgb, CanvasText 34%, transparent); }
#root [data-jian-dragging] { opacity: .35; }

.jian-pop { position: fixed; z-index: 2147483647; box-sizing: border-box;
  color: light-dark(#171716, #f5f5f3);
  background: light-dark(rgba(255, 255, 255, .84), rgba(22, 22, 22, .84));
  border: 1px solid light-dark(rgba(0, 0, 0, .08), rgba(255, 255, 255, .09));
  box-shadow: inset 0 1px 0 light-dark(rgba(255, 255, 255, .7), rgba(255, 255, 255, .07)),
    0 18px 48px -16px light-dark(rgba(0, 0, 0, .18), rgba(0, 0, 0, .65)),
    0 2px 8px -2px light-dark(rgba(0, 0, 0, .08), rgba(0, 0, 0, .4));
  -webkit-backdrop-filter: blur(39px) saturate(170%); backdrop-filter: blur(39px) saturate(170%);
  font: 13px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif; letter-spacing: 0;
  user-select: none; -webkit-user-select: none; }
.jian-pop[hidden], .jian-pop [hidden] { display: none !important; }
.jian-pop button { all: unset; box-sizing: border-box; cursor: pointer; }

#jian-bar { display: flex; align-items: center; gap: 1px; padding: 4px; border-radius: 12px; }
#jian-bar button { display: grid; place-items: center; min-width: 30px; height: 30px;
  padding: 0 6px; border-radius: 8px; font-size: 13.5px; font-weight: 500;
  color: light-dark(#4a4a46, #c9c9c5); }
#jian-bar button:hover { background: light-dark(rgba(0, 0, 0, .05), rgba(255, 255, 255, .07));
  color: light-dark(#171716, #f5f5f3); }
#jian-bar button[aria-pressed=true] { background: light-dark(rgba(0, 0, 0, .09),
  rgba(255, 255, 255, .12)); color: light-dark(#171716, #f5f5f3); }
#jian-bar .rule { width: 1px; height: 18px; margin: 0 4px;
  background: light-dark(rgba(0, 0, 0, .1), rgba(255, 255, 255, .12)); }
#jian-bar input { all: unset; box-sizing: border-box; width: 260px; height: 30px; padding: 0 10px;
  border-radius: 8px; cursor: text; user-select: text; -webkit-user-select: text;
  background: light-dark(rgba(0, 0, 0, .05), rgba(255, 255, 255, .07)); }
#jian-bar input::placeholder { color: light-dark(#686864, #a6a6a3); }

#jian-slash { width: 272px; max-height: min(340px, 60vh); overflow-y: auto; padding: 6px;
  border-radius: 14px; scrollbar-width: thin; }
#jian-slash .title { padding: 6px 8px 4px; font-size: 11.5px; font-weight: 500;
  color: light-dark(#686864, #a6a6a3); }
#jian-slash .item { display: flex; align-items: center; gap: 10px; width: 100%; padding: 5px 8px;
  border-radius: 9px; }
#jian-slash .item[aria-selected=true] { background: light-dark(rgba(0, 0, 0, .06),
  rgba(255, 255, 255, .08)); }
#jian-slash .icon { display: grid; place-items: center; flex: none; width: 30px; height: 30px;
  border-radius: 8px; font-size: 12px; font-weight: 600;
  border: 1px solid light-dark(rgba(0, 0, 0, .08), rgba(255, 255, 255, .09));
  background: light-dark(#ffffff, rgba(255, 255, 255, .04)); }
#jian-slash .label { flex: 1; min-width: 0; }
#jian-slash .keys { font: 11.5px ui-monospace, SFMono-Regular, Menlo, monospace;
  color: light-dark(#686864, #a6a6a3); }
#jian-slash .none { padding: 8px; color: light-dark(#686864, #a6a6a3); }

#jian-handle { position: absolute; z-index: 2147483646; display: flex; gap: 1px;
  user-select: none; -webkit-user-select: none; }
#jian-handle[hidden] { display: none; }
#jian-handle button { all: unset; display: grid; place-items: center; width: 22px; height: 24px;
  border-radius: 6px; cursor: pointer; color: color-mix(in srgb, CanvasText 38%, transparent); }
#jian-handle button[data-act=drag] { cursor: grab; }
#jian-handle button:hover { color: color-mix(in srgb, CanvasText 70%, transparent);
  background: color-mix(in srgb, CanvasText 7%, transparent); }
#jian-drop { position: absolute; z-index: 2147483646; height: 3px; border-radius: 2px;
  pointer-events: none; background: light-dark(rgba(35, 131, 226, .55), rgba(96, 160, 245, .7)); }
#jian-drop[hidden] { display: none; }
`;
