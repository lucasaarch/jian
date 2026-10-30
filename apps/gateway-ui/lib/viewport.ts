'use client';

import { useEffect } from 'react';

/** Less than this between the layout and what is visible is browser chrome, not a keyboard. */
const KEYBOARD_PX = 120;

/**
 * Whether a phone's keyboard is open, as `data-keyboard` on the root: the home indicator is
 * under the keyboard then, so nothing needs to keep clear of it. iOS also shifts the page to
 * show a focused field and can leave it shifted when the keyboard goes; a page with nothing to
 * scroll is put back then. Nothing is repositioned while the person scrolls.
 */
export function useVisibleViewport() {
  useEffect(() => {
    const view = window.visualViewport;
    if (!view) return;
    const root = document.documentElement;
    let open = false;
    const sync = () => {
      const keyboard = root.clientHeight - view.height > KEYBOARD_PX;
      root.toggleAttribute('data-keyboard', keyboard);
      if (open && !keyboard && window.scrollY && root.scrollHeight <= window.innerHeight + 1) {
        window.scrollTo(0, 0);
      }
      open = keyboard;
    };

    sync();
    view.addEventListener('resize', sync);
    return () => {
      view.removeEventListener('resize', sync);
      root.removeAttribute('data-keyboard');
    };
  }, []);
}
