/**
 * How a spreadsheet looks in its frame (sheet-frame.ts). The frame cannot reach the panel's
 * tokens, so its colours are made from the system's own (`Canvas`, `CanvasText`), which follow
 * the theme the frame is drawn in, with the panel's blue for what is picked.
 *
 * - The grid's columns are as wide as the script measures them (`table-layout: fixed`), so
 *   nothing moves under the pointer while a cell is written.
 * - What lies over the grid (the range picked, the cell being written) sits in the same scroll
 *   below the headers, which stay on top as they stick.
 */
export const SHEET_STYLE = `
:root { --line: color-mix(in srgb, CanvasText 11%, transparent);
  --head: color-mix(in srgb, CanvasText 4%, Canvas);
  --muted: color-mix(in srgb, CanvasText 55%, transparent);
  --accent: #4c8dff; --bad: light-dark(#d92d20, #ff6b5e); }
#root { display: flex; flex-direction: column; height: 100vh; }
.sheet-bar { display: flex; flex: none; align-items: stretch; height: 30px;
  border-bottom: 1px solid var(--line); }
.sheet-name { box-sizing: border-box; display: grid; place-items: center; min-width: 64px;
  padding: 0 10px; border-right: 1px solid var(--line); color: var(--muted);
  font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; white-space: nowrap; }
.sheet-fx { display: grid; place-items: center; padding: 0 6px 0 10px; color: var(--muted);
  font: italic 13px Georgia, "Times New Roman", serif; user-select: none; }
.sheet-field { flex: 1; min-width: 0; box-sizing: border-box; margin: 0; padding: 6px 8px 0;
  border: 0; outline: none; resize: none; overflow: hidden; white-space: pre; background: none;
  color: inherit; font: 13px/18px ui-monospace, SFMono-Regular, Menlo, monospace; }
.sheet-scroll { position: relative; flex: 1; overflow: auto; }
.sheet-grid { table-layout: fixed; border-collapse: separate; border-spacing: 0;
  font: 13px/23px system-ui, -apple-system, "Segoe UI", sans-serif; }
.sheet-grid th, .sheet-grid td { box-sizing: border-box; height: 24px; padding: 0 8px;
  border: 0 solid var(--line); border-width: 0 1px 1px 0; white-space: nowrap; overflow: hidden;
  text-overflow: ellipsis; }
.sheet-grid td { cursor: cell; }
.sheet-grid th { position: sticky; z-index: 2; padding: 0 4px; background: var(--head);
  color: var(--muted); font-size: 12px; font-weight: 500; text-align: center;
  user-select: none; }
.sheet-grid thead th { top: 0; }
.sheet-grid tbody th { left: 0; }
.sheet-grid thead th:first-child { left: 0; z-index: 3; }
.sheet-grid th.on { background: color-mix(in srgb, var(--accent) 16%, Canvas); color: CanvasText; }
.sheet-grid td.number { text-align: right; font-variant-numeric: tabular-nums; }
.sheet-grid td.logical { text-align: center; }
.sheet-grid td.error { text-align: center; color: var(--bad); }
.sheet-grid .sheet-gutter, .sheet-grid .sheet-more td { border: 0; background: none; }
.sheet-grid .sheet-more th { border-right: 0; background: none; }
.sheet-grid th:has(> .sheet-add) { border: 0; background: Canvas; }
.sheet-add { all: unset; display: grid; place-items: center; width: 100%; height: 100%;
  border-radius: 6px; color: var(--muted); font: 16px/1 system-ui, sans-serif; cursor: pointer;
  opacity: .6; }
.sheet-add:hover { opacity: 1; color: CanvasText;
  background: color-mix(in srgb, CanvasText 7%, transparent); }
.sheet-range, .sheet-pointed, .sheet-active, .sheet-editor { position: absolute; z-index: 1;
  box-sizing: border-box; pointer-events: none; }
.sheet-range { border: 1px solid var(--accent);
  background: color-mix(in srgb, var(--accent) 10%, transparent); }
.sheet-pointed { border: 2px dashed var(--accent);
  background: color-mix(in srgb, var(--accent) 8%, transparent); }
.sheet-pointed[hidden], .sheet-range[hidden] { display: none; }
.sheet-active { border: 2px solid var(--accent); }
.sheet-editor { margin: 0; padding: 0 7px; border: 2px solid var(--accent); outline: none;
  resize: none; overflow: hidden; white-space: pre-wrap; overflow-wrap: anywhere;
  background: Canvas; color: inherit; font: 13px/20px system-ui, -apple-system, "Segoe UI",
  sans-serif; opacity: 0; caret-color: transparent; }
.writing .sheet-editor { opacity: 1; pointer-events: auto; caret-color: auto;
  box-shadow: 0 4px 14px rgba(0, 0, 0, .18); }
.writing .sheet-active { display: none; }
.sheet-menu { position: fixed; z-index: 10; min-width: 220px; padding: 4px; border-radius: 10px;
  background: light-dark(#fff, #232326); border: 1px solid var(--line);
  box-shadow: 0 12px 32px rgba(0, 0, 0, .2), 0 2px 6px rgba(0, 0, 0, .08);
  font: 13px/1 system-ui, -apple-system, "Segoe UI", sans-serif; user-select: none; }
.sheet-menu[hidden] { display: none; }
.sheet-menu button { all: unset; box-sizing: border-box; display: flex; width: 100%;
  align-items: center; justify-content: space-between; gap: 24px; padding: 7px 10px;
  border-radius: 6px; color: CanvasText; cursor: default; }
.sheet-menu button.lit { background: color-mix(in srgb, CanvasText 8%, transparent); }
.sheet-menu button.danger { color: var(--bad); }
.sheet-menu kbd { font: 12px system-ui, sans-serif; color: var(--muted); }
.sheet-menu hr { margin: 4px 6px; border: 0; border-top: 1px solid var(--line); }
`;
