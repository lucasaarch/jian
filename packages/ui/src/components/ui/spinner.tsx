import { LoaderCircle } from 'lucide-react';

/**
 * Something under way. What turns is a box of exactly the icon's size, with the drawing still
 * inside it: `.spin` says why the drawing itself is never turned.
 */
export function Spinner({ size = 24 }: { size?: number }) {
  return (
    <span className="spin text-muted" style={{ width: size, height: size }} aria-hidden="true">
      <LoaderCircle size={size} />
    </span>
  );
}
