'use client';

import { useEffect, useState } from 'react';

// TEMPORARY: a readout of what iOS reports about the screen, to find why a phone's composer
// sits above the bottom. Shown only with `?viewport` in the address. Remove before 1.0.0.

const round = (value: number | undefined) => (value === undefined ? '-' : Math.round(value));

function read() {
  const view = window.visualViewport;
  const root = document.documentElement;
  const probe = document.getElementById('viewport-probe-insets');
  const insets = probe ? getComputedStyle(probe) : undefined;
  const rect = (selector: string) => {
    const element = document.querySelector(selector);
    if (!element) return '-';
    const box = element.getBoundingClientRect();
    return `${round(box.top)}..${round(box.bottom)}`;
  };

  return [
    `screen ${screen.width}x${screen.height}`,
    `standalone ${matchMedia('(display-mode: standalone)').matches}`,
    `inner ${innerWidth}x${innerHeight} client ${root.clientHeight}`,
    `visual h ${round(view?.height)} top ${round(view?.offsetTop)} scale ${view?.scale ?? '-'}`,
    `scrollY ${round(scrollY)} docH ${root.scrollHeight}`,
    `safe top ${insets?.paddingTop ?? '-'} bottom ${insets?.paddingBottom ?? '-'}`,
    `100dvh ${insets?.height ?? '-'}`,
    `--keyboard-inset ${root.style.getPropertyValue('--keyboard-inset') || '-'} kb ${root.hasAttribute('data-keyboard')}`,
    `main ${rect('.main-content.fill')}`,
    `pane ${rect('.conversation-pane')}`,
    `composer ${rect('.composer')} box ${rect('.composer-box')}`,
  ];
}

export function ViewportProbe() {
  const [lines, setLines] = useState<string[]>();

  useEffect(() => {
    if (!new URLSearchParams(location.search).has('viewport')) return;
    const tick = () => setLines(read());
    tick();
    const timer = setInterval(tick, 300);
    return () => clearInterval(timer);
  }, []);

  if (!lines) return null;

  return (
    <>
      <div
        id="viewport-probe-insets"
        aria-hidden="true"
        style={{
          position: 'fixed',
          visibility: 'hidden',
          pointerEvents: 'none',
          paddingTop: 'env(safe-area-inset-top)',
          paddingBottom: 'env(safe-area-inset-bottom)',
          height: '100dvh',
          top: 0,
          left: 0,
          boxSizing: 'content-box',
        }}
      />
      <pre
        style={{
          position: 'fixed',
          zIndex: 100,
          top: 'calc(env(safe-area-inset-top) + 56px)',
          right: 8,
          margin: 0,
          padding: 8,
          font: '11px/1.35 ui-monospace, monospace',
          background: 'rgb(0 0 0 / 0.8)',
          color: '#7ee787',
          borderRadius: 8,
          pointerEvents: 'none',
          whiteSpace: 'pre',
        }}
      >
        {lines.join('\n')}
      </pre>
    </>
  );
}
