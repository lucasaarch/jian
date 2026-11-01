type Box = { left: number; top: number; right: number; bottom: number };

/** What floats over the app, and a modal's backdrop, which dims everything under it. */
const FLOATING =
  '[role=dialog], [aria-modal=true], [role=menu], [role=presentation], .reload-curtain';

/** A notice: it slides in over the page, so it is judged by where it is going to rest. */
const NOTICE = '[data-sonner-toast]';

/** Where something is, or for a notice still sliding in, where it ends up. */
function placeOf(element: Element): Box {
  const box = element.getBoundingClientRect();
  if (!element.matches(NOTICE)) return box;
  const { transform } = getComputedStyle(element);
  const slid = transform && transform !== 'none' ? new DOMMatrixReadOnly(transform).m42 : 0;
  return { left: box.left, right: box.right, top: box.top - slid, bottom: box.bottom - slid };
}

const overlap = (a: Box, b: Box) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/**
 * Whether something is drawn where the page is. The native page is painted over everything in the
 * window, so it has to step aside for that, and only for that: a menu at the far end of the window
 * leaves it alone. Measured, since a list is in the document before it has its place.
 */
export function coversPage(page: Box, root: ParentNode = document): boolean {
  return [...root.querySelectorAll(`${FLOATING}, ${NOTICE}`)].some((element) =>
    overlap(placeOf(element), page),
  );
}
