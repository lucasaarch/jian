'use client';

import { useEffect } from 'react';

/** Less than this between the layout and what is visible is browser chrome, not a keyboard. */
const KEYBOARD_PX = 120;

/** What the styles read while a keyboard is open (kit.css); none of them is set otherwise. */
const VISIBLE = ['--visible-top', '--visible-height', '--keyboard-inset'] as const;

/**
 * Whether a phone's keyboard is open, as `data-keyboard` on the root: the home indicator is
 * under the keyboard then, so nothing needs to keep clear of it. iOS keeps laying the page out at
 * the full screen behind the keyboard and shows only part of it, so while it is open the root
 * also says which part, in px: `--visible-top` and `--visible-height`, where the app shell
 * stands then, and `--keyboard-inset`, how much of a fixed surface's bottom the keys cover, which
 * a sheet rises by to keep its fields in sight. iOS also shifts the page to show a focused field
 * and can leave it shifted when the keyboard goes; a page with nothing to scroll is put back then.
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
      if (keyboard) {
        const covered = Math.max(0, root.clientHeight - view.offsetTop - view.height);
        root.style.setProperty('--visible-top', `${view.offsetTop}px`);
        root.style.setProperty('--visible-height', `${view.height}px`);
        root.style.setProperty('--keyboard-inset', `${covered}px`);
      } else {
        for (const name of VISIBLE) root.style.removeProperty(name);
      }
      if (open && !keyboard && window.scrollY && root.scrollHeight <= window.innerHeight + 1) {
        window.scrollTo(0, 0);
      }
      open = keyboard;
    };

    sync();
    // iOS moves the part on screen without resizing it to bring a field into view.
    view.addEventListener('resize', sync);
    view.addEventListener('scroll', sync);
    return () => {
      view.removeEventListener('resize', sync);
      view.removeEventListener('scroll', sync);
      root.removeAttribute('data-keyboard');
      for (const name of VISIBLE) root.style.removeProperty(name);
    };
  }, []);
}
