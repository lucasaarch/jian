'use client';

import { ChevronLeft, Mic } from 'lucide-react';
import {
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  useEffect,
  useRef,
  useState,
} from 'react';

/**
 * Why listening ended. `cancel` (slid past the distance) and `escape` throw the recording away;
 * every other reason keeps it.
 */
export type VoiceStop = 'release' | 'tap' | 'key' | 'escape' | 'blur' | 'cancel';

/** In ms: a press shorter than this latches the recording on, a longer one stops on release. */
const HOLD_AFTER = 300;
/** In px: how far left a held press slides before it cancels. */
const CANCEL_DISTANCE = 64;
/** In px: the slide that starts dragging, so a shaky press does not. */
const SLIDE_MIN = 4;
/** In ms: how fast the level rises to a louder signal, and how long it hangs after. */
const ATTACK = 40;
const RELEASE = 240;
/** Bar height when silent, as a fraction of the waveform's height. */
const FLOOR = 0.1;
/** A long frame (a background tab) must not jump the envelope. In seconds. */
const DT_MAX = 0.05;
/** Frames folded into one bar, and the bars kept: the history scrolls at this pace. */
const WAVE_EVERY = 4;
const WAVE_MAX = 80;
/** Frequency bins of a 256-point FFT that carry speech, low to high, averaged band by band. */
const SPEECH_BINS = [
  [1, 4],
  [4, 11],
  [11, 33],
];
const MIC_GAIN = 2.2;

type Meter = { context: AudioContext; analyser: AnalyserNode; bins: Uint8Array<ArrayBuffer> };

type Frame = {
  raf: number;
  last: number;
  startedAt: number;
  envelope: number;
  history: number[];
  tick: number;
  peak: number;
  color: string;
};

function speechLevel({ analyser, bins }: Meter) {
  analyser.getByteFrequencyData(bins);
  let total = 0;

  for (const [low, high] of SPEECH_BINS) {
    let sum = 0;
    for (let index = low; index < high; index += 1) sum += bins[index] ?? 0;
    total += sum / ((high - low) * 255);
  }

  return Math.min(1, (total / SPEECH_BINS.length) * MIC_GAIN);
}

/** Pushes the level into the history and draws it, newest at the right, fading to the left. */
function drawWave(frame: Frame, canvas: HTMLCanvasElement, level: number) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  const context = canvas.getContext('2d');
  if (!context) return;

  frame.peak = Math.max(frame.peak, level);
  frame.tick = (frame.tick + 1) % WAVE_EVERY;
  if (frame.tick === 0) {
    frame.history.push(frame.peak);
    frame.peak = 0;
    if (frame.history.length > WAVE_MAX) frame.history.shift();
  }

  const bar = 2 * dpr;
  const step = 3 * dpr;
  const shift = (frame.tick / WAVE_EVERY) * step;

  context.clearRect(0, 0, width, height);
  context.fillStyle = frame.color;
  for (let index = 0; index < frame.history.length; index += 1) {
    const value = frame.history[frame.history.length - 1 - index] ?? 0;
    const x = width - (index + 1) * step - shift;
    if (x + bar < 0) break;
    const h = Math.max(bar, (FLOOR + (1 - FLOOR) * value) * height);
    const t = Math.min(1, Math.max(0, (x + bar / 2) / (width * 0.55)));

    context.globalAlpha = (0.35 + 0.65 * value) * t * t * (3 - 2 * t);
    context.beginPath();
    context.roundRect(x, (height - h) / 2, bar, h, bar / 2);
    context.fill();
  }
  context.globalAlpha = 1;
}

const clock = (ms: number) => {
  const seconds = Math.floor(ms / 1000);

  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

/**
 * The microphone button, which opens into a capsule with the elapsed time and the voice's level
 * while it records. A tap latches it on and a second tap stops; a hold stops on release, and
 * sliding left while held cancels. It draws the state it is given: `onStart` asks for the
 * microphone, and the capsule opens only once `listening` says the recording began.
 */
export function VoicePill({
  listening,
  stream,
  disabled = false,
  label = 'Record a voice note',
  onStart,
  onStop,
}: {
  listening: boolean;
  /** The recording's own stream, read for the level; the pill never opens a microphone. */
  stream?: MediaStream;
  disabled?: boolean;
  label?: string;
  onStart: () => void;
  onStop: (reason: VoiceStop) => void;
}) {
  const root = useRef<HTMLButtonElement>(null);
  const time = useRef<HTMLSpanElement>(null);
  const wave = useRef<HTMLCanvasElement>(null);
  const [pressed, setPressed] = useState(false);
  const [input, setInput] = useState<'pointer' | 'key'>('pointer');
  // Gesture state lives in a ref: pointer events arrive faster than renders.
  const press = useRef({ pointerId: null as number | null, downX: 0, downAt: 0, own: false });
  const sliding = useRef(false);
  const live = useRef({ listening, onStop });
  live.current = { listening, onStop };

  // The level and the clock, drawn every frame while the recording runs.
  useEffect(() => {
    if (!listening) return;
    let meter: Meter | undefined;

    if (stream) {
      const Context =
        window.AudioContext ??
        (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

      if (Context) {
        const context = new Context();
        // Created once the microphone was granted, after the click: autoplay rules leave it
        // suspended, and a suspended analyser reads silence.
        void context.resume();
        const analyser = context.createAnalyser();

        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0;
        context.createMediaStreamSource(stream).connect(analyser);
        meter = { context, analyser, bins: new Uint8Array(analyser.frequencyBinCount) };
      }
    }

    const now = performance.now();
    const frame: Frame = {
      raf: 0,
      last: now,
      startedAt: now,
      envelope: 0,
      history: [],
      tick: 0,
      peak: 0,
      // The canvas paints with the theme's color, read once from its own style.
      color: wave.current ? getComputedStyle(wave.current).color : 'currentColor',
    };
    if (time.current) time.current.textContent = '0:00';

    const draw = (at: number) => {
      const dt = Math.min((at - frame.last) / 1000, DT_MAX);
      const target = meter ? speechLevel(meter) : 0;
      const tau = (target > frame.envelope ? ATTACK : RELEASE) / 1000;

      frame.last = at;
      frame.envelope += (target - frame.envelope) * (1 - Math.exp(-dt / tau));
      const text = clock(at - frame.startedAt);
      if (time.current && time.current.textContent !== text) time.current.textContent = text;
      if (wave.current) drawWave(frame, wave.current, frame.envelope);
      frame.raf = requestAnimationFrame(draw);
    };
    frame.raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(frame.raf);
      void meter?.context.close();
    };
  }, [listening, stream]);

  // A press the window loses — another tab, an alert — would otherwise never be released.
  useEffect(() => {
    if (!pressed) return;
    const stop = () => {
      press.current.pointerId = null;
      setPressed(false);
      if (live.current.listening) live.current.onStop('blur');
    };
    const hidden = () => {
      if (document.hidden) stop();
    };

    window.addEventListener('blur', stop);
    document.addEventListener('visibilitychange', hidden);

    return () => {
      window.removeEventListener('blur', stop);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, [pressed]);

  const settleSlide = () => {
    sliding.current = false;
    const element = root.current;
    if (!element) return;
    delete element.dataset.sliding;
    element.style.setProperty('--vp-slide', '0px');
    element.style.setProperty('--vp-cancel', '0');
  };

  /** Drops a press without stopping anything, once it is known to have ended unheard. */
  const forget = () => {
    press.current.pointerId = null;
    setPressed(false);
    if (sliding.current) settleSlide();
  };

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    // A press already on record is one whose release never arrived — a permission prompt takes
    // it — so a new primary press replaces it rather than being ignored.
    if (disabled || event.button !== 0 || !event.isPrimary) return;
    press.current = {
      pointerId: event.pointerId,
      downX: event.clientX,
      downAt: performance.now(),
      own: !listening,
    };
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {}
    setPressed(true);
    setInput('pointer');
    if (!listening) onStart();
  };

  const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const element = root.current;
    const current = press.current;
    if (!element || current.pointerId !== event.pointerId) return;
    // The button is no longer down: the release went elsewhere, and a pointer coming back from
    // the browser's prompt is not a slide to cancel.
    if ((event.buttons & 1) === 0) {
      forget();
      return;
    }
    if (!listening || !current.own) return;
    const dx = event.clientX - current.downX;
    if (!sliding.current && dx > -SLIDE_MIN) return;

    sliding.current = true;
    element.dataset.sliding = '';
    const pull = Math.min(CANCEL_DISTANCE + 24, Math.max(0, -dx));
    const progress = Math.min(1, pull / CANCEL_DISTANCE);
    element.style.setProperty('--vp-slide', `${-pull}px`);
    element.style.setProperty('--vp-cancel', progress.toFixed(3));
    if (progress >= 1) {
      settleSlide();
      onStop('cancel');
    }
  };

  const onPointerUp = (event: PointerEvent<HTMLButtonElement>) => {
    const current = press.current;
    if (event.pointerId !== current.pointerId) return;
    current.pointerId = null;
    setPressed(false);
    if (sliding.current) settleSlide();
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {}
    // A recording that has not begun yet — the browser still asking for the microphone — has
    // nothing to stop; it latches once it does.
    if (!live.current.listening) return;
    const held = performance.now() - current.downAt;
    if (!current.own) onStop(held < HOLD_AFTER ? 'tap' : 'release');
    else if (held >= HOLD_AFTER) onStop('release');
  };

  const toggle = () => {
    setInput('key');
    if (listening) onStop('key');
    else onStart();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Escape' && listening) {
      event.preventDefault();
      setInput('key');
      onStop('escape');
    }
  };

  // Enter and Space reach here as the button's own click, as does assistive technology: a click
  // no pointer made toggles. One a pointer made is the pointer handlers' already.
  const onClick = (event: MouseEvent<HTMLButtonElement>) => {
    if (
      event.detail === 0 &&
      press.current.pointerId === null &&
      !(event.nativeEvent as globalThis.PointerEvent).pointerType
    ) {
      toggle();
    }
  };

  return (
    <button
      ref={root}
      type="button"
      className="voice-pill"
      disabled={disabled}
      aria-label={listening ? 'Stop recording' : label}
      aria-pressed={listening}
      data-state={listening ? 'listening' : 'idle'}
      data-pressed={pressed ? '' : undefined}
      data-input={input}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onLostPointerCapture={onPointerUp}
      onKeyDown={onKeyDown}
      onClick={onClick}
      onContextMenu={(event) => event.preventDefault()}
    >
      <span className="voice-pill-surface" aria-hidden="true" />
      <canvas ref={wave} className="voice-pill-wave" />
      <span className="voice-pill-cancel" aria-hidden="true">
        <ChevronLeft size={12} strokeWidth={2.2} />
        Cancel
      </span>
      <span ref={time} className="voice-pill-time" aria-hidden="true">
        0:00
      </span>
      <span className="voice-pill-core">
        <span className="voice-pill-mic">
          <Mic size={18} />
        </span>
        <span className="voice-pill-stop" aria-hidden="true" />
      </span>
    </button>
  );
}
