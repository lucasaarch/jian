/** How long the colours take to cross over, in milliseconds; the same in styles/index.css. */
const FADE = 360;
let fading: ReturnType<typeof setTimeout> | undefined;

/**
 * The theme's colours cross over in place, every surface at once. No snapshot of the page is
 * taken, so glass keeps blurring what is behind it while they do — a view transition's
 * snapshots leave it blurring nothing in Safari. Under reduced motion the theme simply changes.
 */
export function fadeTheme(apply: () => void): void {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    apply();
    return;
  }
  const root = document.documentElement;
  clearTimeout(fading);
  root.classList.add('theme-fade');
  apply();
  fading = setTimeout(() => root.classList.remove('theme-fade'), FADE);
}
