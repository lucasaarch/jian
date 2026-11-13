/**
 * The one look of a button that holds only an icon in the app's bars: the sidebar's, the
 * Inspector's, a screen's header, the title bar. Round, 1.75rem, with no ground or border until
 * a pointer is over it, and pressed while the menu it opens is open. A square or outlined icon
 * button in a bar breaks the set, so a new one takes this rather than its own classes. Its title
 * bar may be dragged by the window, so it stays pressable there. It needs an `aria-label`.
 */
export const iconButton =
  'grid size-7 shrink-0 place-items-center rounded-full text-muted transition-colors [-webkit-app-region:no-drag] hover:bg-glass-hover hover:text-ink data-popup-open:bg-glass-press data-popup-open:text-ink disabled:pointer-events-none disabled:opacity-40';
