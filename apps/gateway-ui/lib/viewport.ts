'use client';

import { useEffect } from 'react';

/** Less than this between the window and what is visible is browser chrome, not a keyboard. */
const KEYBOARD_PX = 120;

/**
 * The part of the screen a person can actually see, for a phone's keyboard. iOS lays the page
 * out as if the keyboard were not there, shifts the visible part over it to show the focused
 * field, and leaves the page shifted when the keyboard goes. A screen that is an app of its own
 * (a conversation) places itself by `--viewport-top` and `--keyboard-inset` instead, so its
 * composer sits on the keyboard and comes back to the bottom after.
 *
 * `data-keyboard` on the root says a keyboard is open: the home indicator is under it then, so
 * nothing needs to keep clear of it.
 */
export function useVisibleViewport() {
  useEffect(() => {
    const view = window.visualViewport;
    if (!view) return;
    const root = document.documentElement;
    const sync = () => {
      // What the keyboard covers of the layout, from its bottom edge. Read against the layout
      // rather than used as a height: on an installed iOS app a screen sized by the visible
      // height (or by 100dvh) ended well above the bottom, keyboard closed or not.
      const covered = root.clientHeight - view.height - view.offsetTop;
      const keyboard = covered > KEYBOARD_PX;
      root.style.setProperty('--viewport-top', `${view.offsetTop}px`);
      root.style.setProperty('--keyboard-inset', `${keyboard ? Math.round(covered) : 0}px`);
      root.toggleAttribute('data-keyboard', keyboard);
      // A page with nothing to scroll was only shifted for the keyboard: put it back. A long
      // page keeps the place its reader scrolled to.
      if (!keyboard && window.scrollY && root.scrollHeight <= window.innerHeight + 1) {
        window.scrollTo(0, 0);
      }
    };

    sync();
    view.addEventListener('resize', sync);
    view.addEventListener('scroll', sync);
    return () => {
      view.removeEventListener('resize', sync);
      view.removeEventListener('scroll', sync);
      root.style.removeProperty('--viewport-top');
      root.style.removeProperty('--keyboard-inset');
      root.removeAttribute('data-keyboard');
    };
  }, []);
}
