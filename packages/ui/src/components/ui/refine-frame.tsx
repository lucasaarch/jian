'use client';

import { Check, LoaderCircle, RotateCw, TriangleAlert } from 'lucide-react';
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react';

// Adapted from React Bits' RefineFrame: Lucide icons, the panel's own colours, styles in
// refine-frame.css, and a frame that mounts already sharp when its picture was ready before it.

export type RefineStatus = 'queued' | 'generating' | 'refining' | 'complete' | 'error';

type Stage = { blur: number; sat: number; scale: number; opacity: number };
type Sim = {
  p: number;
  raf: number;
  last: number;
  key: string;
  w: number;
  h: number;
  levels: HTMLCanvasElement[];
  glint: CanvasGradient | null;
  sent: boolean;
  dream?: Dream;
};
/** The mosaic a frame shows before it has a picture: two fields of blocks and a front between. */
type Dream = {
  w: number;
  h: number;
  ink: string;
  paper: string;
  at: number;
  index: number;
  from: HTMLCanvasElement;
  to: HTMLCanvasElement;
};

/** How each stage dresses the media before the mosaic takes over. */
const STAGES: Record<RefineStatus, Stage> = {
  queued: { blur: 4, sat: 0.6, scale: 1.04, opacity: 0.55 },
  generating: { blur: 1.5, sat: 0.8, scale: 1.02, opacity: 0.85 },
  refining: { blur: 0.5, sat: 0.95, scale: 1.005, opacity: 1 },
  complete: { blur: 0, sat: 1, scale: 1, opacity: 1 },
  error: { blur: 2, sat: 0.5, scale: 1, opacity: 0.28 },
};
/** How far the mosaic has resolved at each stage, from blocks (0) to the picture itself (1). */
const TARGET: Partial<Record<RefineStatus, number>> = {
  queued: 0,
  generating: 0.5,
  refining: 0.875,
  complete: 1,
};
/** Mosaic block sizes in CSS px, coarsest first; 1 is the picture. */
const LEVELS = [48, 32, 20, 12, 8, 5, 3, 2, 1];
/** The soft edge between two levels, in CSS px, drawn as this many fading strips. */
const EDGE = 28;
const STRIPS = 14;
/** Each stage's tween, in ms. */
const STAGE_MS = 400;
/** How long "Ready" stays after a picture resolves, in ms. */
const HIDE_AFTER_MS = 1200;
const LABELS: Record<RefineStatus, string> = {
  queued: 'Queued',
  generating: 'Generating',
  refining: 'Refining',
  complete: 'Ready',
  error: 'Failed',
};
const ACTIVE = new Set<RefineStatus>(['queued', 'generating', 'refining']);

/** Block sizes in CSS px of the fields a frame without a picture moves through, in a loop. */
const DREAM_BLOCKS = [24, 16, 12, 16];
/** How long one front takes to cross the frame, in ms. */
const DREAM_MS = 1400;

/** A field of blocks in the ink, each its own faint shade, on the frame's paper. */
function field(W: number, H: number, block: number, ink: string, paper: string) {
  const cols = Math.ceil(W / block);
  const rows = Math.ceil(H / block);
  const small = document.createElement('canvas');
  small.width = cols;
  small.height = rows;
  const sc = small.getContext('2d');
  if (sc) {
    sc.fillStyle = paper;
    sc.fillRect(0, 0, cols, rows);
    sc.fillStyle = ink;
    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < cols; x += 1) {
        sc.globalAlpha = 0.02 + Math.random() ** 2 * 0.14;
        sc.fillRect(x, y, 1, 1);
      }
    }
  }
  const full = document.createElement('canvas');
  full.width = W;
  full.height = H;
  const fc = full.getContext('2d');
  if (fc) {
    fc.imageSmoothingEnabled = false;
    fc.drawImage(small, 0, 0, cols * block, rows * block);
  }
  return full;
}

/**
 * `next` coming down over what is drawn behind a soft front, `frac` of the way: the move of the
 * reveal, shared with the frame that has no picture yet.
 */
function front(
  ctx: CanvasRenderingContext2D,
  next: HTMLCanvasElement,
  frac: number,
  w: number,
  h: number,
  dpr: number,
  line?: { style: string | CanvasGradient; soft: number; sharp: number },
) {
  const edge = EDGE * dpr;
  const at = frac * (h + edge) - edge / 2;
  const top = Math.max(0, Math.floor(at - edge / 2));
  if (top > 0) ctx.drawImage(next, 0, 0, w, top, 0, 0, w, top);
  const strip = edge / STRIPS;
  for (let k = 0; k < STRIPS; k += 1) {
    const y = at - edge / 2 + k * strip;
    if (y + strip <= 0 || y >= h) continue;
    const t = 1 - (k + 0.5) / STRIPS;
    ctx.globalAlpha = t * t * (3 - 2 * t);
    const y0 = Math.max(0, y);
    const h0 = Math.min(h, y + strip) - y0;
    if (h0 > 0) ctx.drawImage(next, 0, y0, w, h0, 0, y0, w, h0);
  }
  ctx.globalAlpha = 1;
  if (line && at > 0 && at < h) {
    ctx.fillStyle = line.style;
    ctx.globalAlpha = line.soft;
    ctx.fillRect(0, at - 2 * dpr, w, 4 * dpr);
    ctx.globalAlpha = line.sharp;
    ctx.fillRect(0, at - dpr, w, 2 * dpr);
    ctx.globalAlpha = 1;
  }
}

/**
 * A frame at work with nothing to show yet: fields of blocks, each finer or coarser than the
 * last, brought down one after another by the same front the picture will resolve behind.
 */
function dream(
  s: Sim,
  canvas: HTMLCanvasElement,
  frame: HTMLElement,
  now: number,
  dpr: number,
  still: boolean,
) {
  const rect = canvas.getBoundingClientRect();
  const W = Math.max(1, Math.round(rect.width * dpr));
  const H = Math.max(1, Math.round(rect.height * dpr));
  const style = getComputedStyle(frame);
  const ink = style.color;
  const paper = style.backgroundColor;
  const blocks = (index: number) => (DREAM_BLOCKS[index % DREAM_BLOCKS.length] as number) * dpr;
  let d = s.dream;
  // Drawn again for a new size or a new theme; a picture's levels are built afresh after it.
  if (!d || d.w !== W || d.h !== H || d.ink !== ink || d.paper !== paper) {
    canvas.width = W;
    canvas.height = H;
    s.key = '';
    d = {
      w: W,
      h: H,
      ink,
      paper,
      at: now,
      index: 0,
      from: field(W, H, blocks(0), ink, paper),
      to: field(W, H, blocks(1), ink, paper),
    };
    s.dream = d;
  }
  let frac = (now - d.at) / DREAM_MS;
  if (frac >= 1) {
    d.index += 1;
    d.from = d.to;
    d.to = field(W, H, blocks(d.index + 1), ink, paper);
    d.at = now;
    frac = 0;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.globalAlpha = 1;
  ctx.drawImage(d.from, 0, 0);
  if (!still) front(ctx, d.to, frac, W, H, dpr, { style: ink, soft: 0.04, sharp: 0.1 });
}

/** Each mosaic level drawn once per picture and size, so a frame only copies canvases. */
function build(s: Sim, canvas: HTMLCanvasElement, img: HTMLImageElement, dpr: number) {
  const rect = canvas.getBoundingClientRect();
  const W = Math.max(1, Math.round(rect.width * dpr));
  const H = Math.max(1, Math.round(rect.height * dpr));
  const key = `${img.currentSrc}|${W}x${H}`;
  if (s.key === key) return;
  s.key = key;
  s.w = W;
  s.h = H;
  canvas.width = W;
  canvas.height = H;
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;
  const cover = Math.max(W / iw, H / ih);
  const sw = W / cover;
  const sh = H / cover;
  const sx = (iw - sw) / 2;
  const sy = (ih - sh) / 2;
  const glint = canvas.getContext('2d')?.createLinearGradient(0, 0, W, 0) ?? null;
  if (glint) {
    for (const [at, alpha] of [
      [0, 0],
      [0.08, 0.1],
      [0.2, 0.7],
      [0.32, 1],
      [0.68, 1],
      [0.8, 0.7],
      [0.92, 0.1],
      [1, 0],
    ] as const) {
      glint.addColorStop(at, `rgba(255, 255, 255, ${alpha})`);
    }
  }
  s.glint = glint;
  s.levels = LEVELS.map((block) => {
    const b = block === 1 ? 1 : Math.max(2, Math.round(block * dpr));
    const full = document.createElement('canvas');
    full.width = W;
    full.height = H;
    const fc = full.getContext('2d');
    if (!fc) return full;
    if (b === 1) {
      fc.imageSmoothingEnabled = true;
      fc.imageSmoothingQuality = 'high';
      fc.drawImage(img, sx, sy, sw, sh, 0, 0, W, H);
      return full;
    }
    const small = document.createElement('canvas');
    small.width = Math.max(1, Math.round(W / b));
    small.height = Math.max(1, Math.round(H / b));
    const sc = small.getContext('2d');
    if (sc) {
      sc.imageSmoothingEnabled = true;
      sc.imageSmoothingQuality = 'high';
      sc.drawImage(img, sx, sy, sw, sh, 0, 0, small.width, small.height);
    }
    fc.imageSmoothingEnabled = false;
    fc.drawImage(small, 0, 0, W, H);
    return full;
  });
}

/**
 * A picture that is still on its way: shifting blocks while it is made or fetched, then a
 * mosaic that resolves into it. The box is reserved from the start, so nothing shifts when
 * the picture arrives. `fill` takes the parent's whole box, as a mosaic tile does.
 */
export function RefineFrame({
  status = 'generating',
  children,
  aspectRatio = '4 / 3',
  width = 320,
  fill = false,
  labels,
  retryLabel = 'Retry',
  onRetry,
  className,
}: {
  status?: RefineStatus;
  /** The media, an img; it fills the frame. */
  children?: ReactNode;
  aspectRatio?: string;
  /** In px, capped at the parent. */
  width?: number;
  fill?: boolean;
  labels?: Partial<Record<RefineStatus, string>>;
  retryLabel?: string;
  onRetry?: () => void;
  className?: string;
}) {
  const stage = STAGES[status];
  const active = ACTIVE.has(status);
  const text = { ...LABELS, ...labels };
  const frameRef = useRef<HTMLDivElement>(null);
  const printRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // A picture that was ready before the frame was drawn starts resolved: no mosaic replay for
  // every image of a conversation each time it is opened.
  const sim = useRef<Sim>({
    p: TARGET[status] ?? 0,
    raf: 0,
    last: 0,
    key: '',
    w: 0,
    h: 0,
    levels: [],
    glint: null,
    sent: false,
  });
  const live = useRef({ status, reduce: false });
  live.current.status = status;
  const [mosaic, setMosaic] = useState(false);
  // "Ready" is said only by a frame that was seen working; one drawn complete says nothing.
  const worked = useRef(active);
  const [chip, setChip] = useState(status !== 'complete');

  useEffect(() => {
    if (status !== 'complete') {
      worked.current ||= ACTIVE.has(status);
      setChip(true);
      return undefined;
    }
    if (!worked.current) {
      setChip(false);
      return undefined;
    }
    setChip(true);
    const timer = setTimeout(() => setChip(false), HIDE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [status]);

  const tick = (now: number) => {
    const s = sim.current;
    const c = live.current;
    const canvas = canvasRef.current;
    const img = printRef.current?.querySelector('img');
    const frame = frameRef.current;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (!canvas || !frame) {
      s.raf = 0;
      return;
    }
    if (!img?.naturalWidth) {
      // Nothing to resolve yet: a frame at work dreams in blocks until the picture is here.
      if (ACTIVE.has(c.status)) dream(s, canvas, frame, now, dpr, c.reduce);
      s.raf = ACTIVE.has(c.status) && !c.reduce ? requestAnimationFrame(tick) : 0;
      return;
    }
    const dt = Math.min(0.05, s.last ? (now - s.last) / 1000 : 0.016);
    s.last = now;
    build(s, canvas, img, dpr);
    const n = s.levels.length - 1;
    const target = TARGET[c.status] ?? s.p;
    const rate = c.reduce ? 1e9 : 1 / (n * (STAGE_MS / 1000));
    const step = rate * dt;
    if (target < s.p || target - s.p <= step) s.p = target;
    else s.p += step;
    const ctx = canvas.getContext('2d');
    const level = (index: number) => s.levels[index] as HTMLCanvasElement;
    if (ctx) {
      const L = s.p * n;
      const i = Math.min(n, Math.floor(L + 1e-6));
      const frac = L - i;
      ctx.globalAlpha = 1;
      ctx.drawImage(level(i), 0, 0);
      if (i < n && frac > 0) {
        front(
          ctx,
          level(i + 1),
          frac,
          s.w,
          s.h,
          dpr,
          !c.reduce && s.glint ? { style: s.glint, soft: 0.12, sharp: 0.3 } : undefined,
        );
      }
    }
    const done = s.p >= 1;
    if (done !== s.sent) {
      s.sent = done;
      // Set on the element by the loop that knows, rather than through a render: the frame
      // hands the picture back the moment the last level lands.
      frameRef.current?.toggleAttribute('data-resolved', done);
    }
    // Until it is exactly there: a loop that stopped "close enough" left the last step at
    // 0.9998, and a frame short of 1 never hands its picture back.
    const keep = (!c.reduce && ACTIVE.has(c.status)) || s.p !== target;
    s.raf = keep ? requestAnimationFrame(tick) : 0;
    if (!keep) s.last = 0;
  };
  const wake = () => {
    if (!sim.current.raf) sim.current.raf = requestAnimationFrame(tick);
  };

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => {
      live.current.reduce = query.matches;
    };
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the picture is read from the DOM whenever the media or the stage changes.
  useEffect(() => {
    const img = printRef.current?.querySelector('img');
    if (!img) {
      setMosaic(false);
      return undefined;
    }
    let gone = false;
    const start = () => {
      if (gone) return;
      setMosaic(true);
      wake();
    };
    if (img.complete && img.naturalWidth) start();
    else img.addEventListener('load', start, { once: true });
    return () => {
      gone = true;
      img.removeEventListener('load', start);
    };
  }, [children, status]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new stage or box restarts the tween.
  useEffect(() => {
    wake();
  }, [status, width, aspectRatio]);

  useEffect(() => {
    const s = sim.current;
    // Forgotten as well as cancelled: a frame id left behind reads as a loop still running,
    // and nothing would wake it again once the frame is back (as development mounts twice).
    return () => {
      cancelAnimationFrame(s.raf);
      s.raf = 0;
      s.last = 0;
    };
  }, []);

  return (
    <div
      ref={frameRef}
      className={`refine-frame${className ? ` ${className}` : ''}`}
      aria-busy={active || undefined}
      data-status={status}
      data-fill={fill || undefined}
      data-dream={(active && !mosaic) || undefined}
      data-mosaic={mosaic || undefined}
      style={
        {
          '--rf-w': `${width}px`,
          '--rf-aspect': aspectRatio,
          '--rf-stage': `${STAGE_MS}ms`,
          '--rf-blur': `${mosaic || active ? 0 : stage.blur}px`,
          '--rf-sat': stage.sat,
          '--rf-scale': mosaic || active ? 1 : stage.scale,
          '--rf-opacity': stage.opacity,
        } as CSSProperties
      }
    >
      <div className="refine-frame-stage" aria-hidden="true">
        <div ref={printRef} className="refine-frame-print">
          {children}
        </div>
        <canvas ref={canvasRef} className="refine-frame-canvas" />
      </div>
      {chip && (
        <div className="refine-frame-chip" aria-hidden="true">
          <span className="refine-frame-mark" data-kind={active ? 'spin' : status}>
            {status === 'complete' ? (
              <Check size={13} strokeWidth={2.5} />
            ) : status === 'error' ? (
              <TriangleAlert size={13} strokeWidth={2.2} />
            ) : (
              <LoaderCircle size={13} strokeWidth={2.2} />
            )}
          </span>
          <span key={status} className="refine-frame-label">
            {text[status]}
          </span>
        </div>
      )}
      {status === 'error' && onRetry && (
        <button type="button" className="refine-frame-retry" onClick={onRetry}>
          <RotateCw size={14} strokeWidth={2.2} />
          <span>{retryLabel}</span>
        </button>
      )}
      <span className="sr-only" role="status">
        {text[status]}
      </span>
    </div>
  );
}
