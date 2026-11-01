type Box = { left: number; top: number; right: number; bottom: number };

/** What floats over the app, and a modal's backdrop, which dims everything under it. */
const FLOATING =
  '[role=dialog], [aria-modal=true], [role=menu], [role=presentation], .reload-curtain';

const overlap = (a: Box, b: Box) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/**
 * Whether something is drawn where the page is. The native page is painted over everything in the
 * window, so it has to step aside for that, and only for that: a menu at the far end of the window
 * leaves it alone. Measured, since a list is in the document before it has its place.
 */
export function coversPage(page: Box, root: ParentNode = document): boolean {
  return [...root.querySelectorAll(FLOATING)].some((element) =>
    overlap(element.getBoundingClientRect(), page),
  );
}
