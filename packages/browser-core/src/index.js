import { zipSync } from 'fflate';
export function packInspection({
  url,
  title,
  viewport,
  actions,
  frames,
  resources,
  blocked,
  framesTruncated = false,
}) {
  const files = {};
  const manifest = resources.map((resource, index) => {
    const path = `resources/${String(index).padStart(4, '0')}`;
    files[path] = resource.data;
    return {
      url: resource.url,
      mimeType: resource.mimeType,
      bytes: resource.data.length,
      path,
    };
  });
  for (const frame of frames) files[`frames/${frame.index}.html`] = Buffer.from(frame.html);
  const snapshot = {
    url: url,
    title: title,
    viewport: viewport,
    actions: actions,
    frames: frames.map(({ html: _, ...frame }) => frame),
    resources: manifest,
    blocked,
    framesTruncated: framesTruncated,
    sourceNote:
      'Rendered DOM, computed styles and publicly served resources. These are not the original private project sources. Blocked resources and truncation are listed explicitly.',
  };
  files['inspection.json'] = Buffer.from(JSON.stringify(snapshot, null, 2));
  const archive = zipSync(files, { level: 3 });
  if (archive.byteLength > 64 * 1024 * 1024)
    throw new Error('Page inspection exceeds the 64 MiB export limit');

  return { archive, snapshot };
}

function snapshotDocument() {
  const properties = [
    'display',
    'position',
    'width',
    'height',
    'color',
    'background-color',
    'font-family',
    'font-size',
    'font-weight',
    'line-height',
    'padding',
    'margin',
    'gap',
    'border',
    'border-radius',
    'box-shadow',
    'grid-template-columns',
    'flex-direction',
    'align-items',
    'justify-content',
    'background-image',
    'background-size',
    'background-position',
    'object-fit',
    'opacity',
    'transform',
    'z-index',
    'overflow',
    'text-align',
    'letter-spacing',
    'text-decoration',
    'fill',
    'stroke',
    'stroke-width',
  ];
  const elements = [...document.querySelectorAll('body *')].filter((element) => {
    const rect = element.getBoundingClientRect();
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      !['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(element.tagName)
    );
  });
  const selector = (element) => {
    const parts = [];
    for (let node = element; node && node !== document.documentElement; node = node.parentElement) {
      if (node.id) {
        parts.unshift(`#${CSS.escape(node.id)}`);
        break;
      }
      const siblings = node.parentElement
        ? [...node.parentElement.children].filter((sibling) => sibling.tagName === node?.tagName)
        : [];
      parts.unshift(`${node.tagName.toLowerCase()}:nth-of-type(${siblings.indexOf(node) + 1})`);
    }
    return parts.join(' > ');
  };
  const html = document.documentElement.outerHTML;
  const text = document.body?.innerText ?? '';
  return {
    title: document.title,
    text: text.slice(0, 3e4),
    textTruncated: text.length > 3e4,
    html: html.slice(0, 2e6),
    htmlTruncated: html.length > 2e6,
    scroll: {
      x: scrollX,
      y: scrollY,
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
    },
    elements: elements.slice(0, 500).map((element) => {
      const rect = element.getBoundingClientRect();
      const computed = getComputedStyle(element);
      return {
        selector: selector(element),
        tag: element.tagName.toLowerCase(),
        text: (element.innerText ?? '').slice(0, 150),
        bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        styles: Object.fromEntries(
          properties.map((name) => [name, computed.getPropertyValue(name)]),
        ),
      };
    }),
    elementsTruncated: elements.length > 500,
    controls: elements
      .filter((element) =>
        element.matches('a,button,input,select,textarea,[role="button"],[role="tab"],summary'),
      )
      .slice(0, 100)
      .map((element) => ({
        selector: selector(element),
        tag: element.tagName.toLowerCase(),
        name: element.getAttribute('aria-label') ?? element.innerText?.slice(0, 150) ?? '',
        type: element.getAttribute('type'),
        href: element.getAttribute('href'),
      })),
    assets: [...document.querySelectorAll('img')].slice(0, 100).map((image) => ({
      url: image.currentSrc || image.src,
      alt: image.alt,
      width: image.naturalWidth,
      height: image.naturalHeight,
    })),
  };
}

export { snapshotDocument };
