import { SLIDE_HEIGHT, SLIDE_WIDTH } from '@jian/contracts';

/**
 * A whole deck on a page of its own, which is what its public link answers: one slide at a time
 * on its fixed canvas, scaled to the window, with the arrows to step through and Present to fill
 * the screen with it.
 *
 * - Each slide is a frame written into this page, never loaded, so it is bound by the page's
 *   policy and sandbox. A slide gets nothing more: it is given no `allow`, so it cannot take the
 *   screen, and it cannot be reached by a click while the deck is presented.
 * - Presenting asks the browser for the whole screen and, where that is refused (a phone, a
 *   frame with no leave to), fills the window instead. The keys and a click step through it;
 *   Escape ends it, as does leaving the whole screen the browser's own way.
 * - A slide comes in over the one before it, once it has loaded, so there is no flash of an empty
 *   sheet. Whoever asked for less motion gets the next slide at once.
 *
 * It is script for the page (document.ts), kept as text: the body of the page's `draw`, with
 * `source` (the deck as a version keeps it) and `root` in reach. It reads nothing but that and
 * sends nothing anywhere.
 */

/** How long a slide takes to come in, in milliseconds. The style and the script must agree. */
const ENTER_MS = 320;

export const PLAYER_STYLE = `
body.deck #root { position: relative; display: grid; grid-template-rows: minmax(0, 1fr) auto;
  height: 100vh; }
#stage { position: relative; display: grid; place-items: center; min-height: 0; overflow: hidden; }
#sheet { position: relative; overflow: hidden; background: #fff;
  box-shadow: 0 0 0 1px color-mix(in srgb, CanvasText 15%, transparent); }
#sheet .slide { position: absolute; inset: 0; opacity: 0; transform: translateX(var(--from, 0));
  transition: opacity ${ENTER_MS}ms ease, transform ${ENTER_MS}ms ease; }
#sheet .slide.in { opacity: 1; transform: none; }
#sheet iframe { position: absolute; top: 0; left: 0; width: ${SLIDE_WIDTH}px;
  height: ${SLIDE_HEIGHT}px; max-width: none; border: 0; transform-origin: 0 0; }
#tap { display: none; position: absolute; inset: 0; margin: 0; padding: 0; border: 0;
  background: none; cursor: default; }
#steps { display: flex; justify-content: center; align-items: center; gap: 12px; padding: 8px;
  font-variant-numeric: tabular-nums; }
#steps button { display: grid; place-items: center; width: 32px; height: 32px; padding: 0;
  border: 0; border-radius: 999px; font: inherit; font-size: 18px; color: inherit;
  background: color-mix(in srgb, CanvasText 8%, transparent); cursor: pointer; }
#steps button:disabled { opacity: .4; cursor: default; }
#steps button#present { display: flex; gap: 6px; width: auto; padding: 0 14px; font-size: 13px; }
#steps svg { width: 16px; height: 16px; max-width: none; }
#steps button#leave { display: none; }
body.presenting { background: #000; color: #fff; }
body.presenting #root { grid-template-rows: minmax(0, 1fr); }
body.presenting #sheet { box-shadow: none; }
body.presenting #tap { display: block; }
/* Out of the slide's way until the pointer or the keyboard comes for it. */
body.presenting #steps { position: absolute; inset-inline: 0; bottom: 0; padding: 20px 8px;
  opacity: 0; transition: opacity 200ms ease; }
body.presenting #steps:hover, body.presenting #steps:focus-within { opacity: 1; }
body.presenting #steps > * { background: rgba(28, 28, 30, .78); }
body.presenting #count { padding: 6px 12px; border-radius: 999px; }
body.presenting #steps button#present { display: none; }
body.presenting #steps button#leave { display: grid; }
@media (prefers-reduced-motion: reduce) {
  #sheet .slide, body.presenting #steps { transition: none; }
  #sheet .slide { transform: none; }
}
`;

const icon = (path: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`;

export const PLAYER = `const slides = JSON.parse(source).slides;
const last = slides.length - 1;
let at = -1;
let presenting = false;
const make = (tag, id) => Object.assign(document.createElement(tag), { id });
const stage = make('div', 'stage');
const sheet = make('div', 'sheet');
const tap = make('button', 'tap');
const steps = make('nav', 'steps');
const count = make('span', 'count');
const button = (id, label, inside, act) => {
  const made = Object.assign(make('button', id), { type: 'button', innerHTML: inside });
  made.setAttribute('aria-label', label);
  made.addEventListener('click', act);
  return made;
};
const fit = () => {
  // Presented, the slide takes all the room there is; otherwise it keeps a margin.
  const margin = presenting ? 0 : 32;
  const scale = Math.max(0, Math.min((stage.clientWidth - margin) / ${SLIDE_WIDTH}, (stage.clientHeight - margin) / ${SLIDE_HEIGHT}));
  sheet.style.width = ${SLIDE_WIDTH} * scale + 'px';
  sheet.style.height = ${SLIDE_HEIGHT} * scale + 'px';
  for (const frame of sheet.querySelectorAll('iframe')) frame.style.transform = 'scale(' + scale + ')';
};
const go = (to) => {
  const target = Math.max(0, Math.min(last, to));
  if (target === at) return;
  const before = [...sheet.children];
  const slide = make('div', '');
  const frame = document.createElement('iframe');
  slide.className = 'slide';
  // The first one is simply there; the others come in from the side they are on.
  if (at < 0) slide.classList.add('in');
  else slide.style.setProperty('--from', target > at ? '24px' : '-24px');
  at = target;
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.title = 'Slide ' + (at + 1);
  frame.srcdoc = slides[at];
  let shown = false;
  const show = () => {
    if (shown) return;
    shown = true;
    // Read first, so the browser has the slide as it starts before it is told where it ends.
    void slide.offsetWidth;
    slide.classList.add('in');
    // By the clock, not by the transition's own event, which less motion never sends.
    setTimeout(() => { for (const old of before) old.remove(); }, ${ENTER_MS});
  };
  frame.addEventListener('load', show);
  setTimeout(show, 600);
  slide.append(frame);
  sheet.append(slide);
  count.textContent = at + 1 + ' / ' + slides.length;
  back.disabled = at === 0;
  next.disabled = at === last;
  fit();
};
const leave = () => {
  if (!presenting) return;
  presenting = false;
  document.body.classList.remove('presenting');
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  fit();
  present.focus();
};
const enter = () => {
  presenting = true;
  document.body.classList.add('presenting');
  // The keyboard stays with the page, and the steps stay hidden until they are come for.
  present.blur();
  fit();
  const whole = document.documentElement;
  // Refused, as where a page may not take the screen: it fills the window all the same.
  if (whole.requestFullscreen) whole.requestFullscreen().catch(() => {});
};
const back = button('', 'Previous slide', '\\u2039', () => go(at - 1));
const next = button('', 'Next slide', '\\u203a', () => go(at + 1));
const present = button('present', 'Present', ${JSON.stringify(icon('M2 3h20M21 3v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V3M7 21l5-5 5 5'))} + '<span>Present</span>', enter);
const end = button('leave', 'End presentation', ${JSON.stringify(icon('M18 6 6 18M6 6l12 12'))}, leave);
// The whole screen moves on at a click. The keyboard has its keys and the buttons below.
tap.type = 'button';
tap.tabIndex = -1;
tap.setAttribute('aria-hidden', 'true');
tap.addEventListener('click', () => go(at + 1));
steps.setAttribute('aria-label', 'Slides');
steps.append(back, count, next, present, end);
stage.append(sheet, tap);
root.append(stage, steps);
addEventListener('resize', fit);
// The browser's own Escape leaves the whole screen without a key reaching the page.
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) leave();
  fit();
});
addEventListener('keydown', (event) => {
  if (event.key === 'Escape') return leave();
  const by = { ArrowRight: 1, ArrowDown: 1, PageDown: 1, ' ': 1, ArrowLeft: -1, ArrowUp: -1, PageUp: -1 }[event.key];
  const to = event.key === 'Home' ? 0 : event.key === 'End' ? last : by ? at + by : undefined;
  if (to === undefined) return;
  // Space on one of its buttons presses that button.
  if (event.key === ' ' && event.target.closest && event.target.closest('button')) return;
  event.preventDefault();
  go(to);
});
go(0);`;
