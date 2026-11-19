import { describe, expect, it } from 'vitest';
import { layoutSlide } from './layouts';

const read = (html: string) => new DOMParser().parseFromString(html, 'text/html');

describe('a new slide from a layout', () => {
  it('keeps the look of the slide it is made from, and none of what it said or ran', () => {
    const made = read(
      layoutSlide(
        'columns',
        '<!doctype html><html><head><style>.slide { background: #123; color: #fff; }</style>' +
          '<script>document.body.dataset.drawn = "1"</script></head>' +
          '<body class="deck"><div class="slide" style="padding: 40px">' +
          '<h1>Revenue</h1><p>Up 12%</p><script>chart()</script></div></body></html>',
      ),
    );

    expect(made.querySelector('style')?.textContent).toContain('background: #123');
    expect(made.body.className).toBe('deck');
    // The frame the agent drew the slide in holds the layout now.
    const frame = made.body.firstElementChild;
    expect(frame?.className).toBe('slide');
    expect(frame?.getAttribute('style')).toBe('padding: 40px');
    expect(made.body.children).toHaveLength(1);
    expect(made.querySelectorAll('script')).toHaveLength(0);
    expect(made.body.textContent).not.toContain('Revenue');
    expect(
      [...made.querySelectorAll('[data-jian-placeholder]')].map((node) => node.textContent),
    ).toEqual(['Click to add title', 'Click to add text', 'Click to add text']);
  });

  it('writes into the body when the slide has no frame of its own', () => {
    const made = read(
      layoutSlide(
        'title',
        '<html><body style="background: navy"><h1>One</h1><p>Two</p></body></html>',
      ),
    );

    expect(made.body.getAttribute('style')).toBe('background: navy');
    expect(made.body.textContent).not.toContain('One');
    expect(made.querySelector('h1')?.textContent).toBe('Click to add title');
  });

  it('is blank when asked, and plain when the deck gives it nothing to follow', () => {
    expect(
      read(layoutSlide('blank', '<body><main><p>Gone</p></main></body>')).body.textContent,
    ).toBe('');
    const plain = read(layoutSlide('text', undefined));
    expect(plain.querySelector('style')?.textContent).toContain('1280px');
    expect(plain.querySelector('h2')?.textContent).toBe('Click to add title');
  });
});
