'use client';

import { Pause, Play } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

/** Bars in the waveform: enough to read the shape of speech, few enough to stay crisp. */
const BARS = 48;
const speeds = [1, 1.5, 2];

const clock = (seconds: number) => {
  const total = Number.isFinite(seconds) ? Math.floor(seconds) : 0;

  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

/**
 * The loudness of each slice of the recording, from 0 to 1, and its length. Decoding happens
 * once, in the browser; a format it cannot decode gets an even line, and the player still plays
 * it. The length matters because a fresh browser recording reports none until played through.
 */
async function waveform(src: string): Promise<{ peaks: number[]; seconds: number }> {
  const context = new AudioContext();

  try {
    const audio = await context.decodeAudioData(await (await fetch(src)).arrayBuffer());
    const samples = audio.getChannelData(0);
    const size = Math.floor(samples.length / BARS) || 1;
    const peaks = Array.from({ length: BARS }, (_, bar) => {
      let peak = 0;

      for (let index = bar * size; index < (bar + 1) * size && index < samples.length; index += 1) {
        peak = Math.max(peak, Math.abs(samples[index] ?? 0));
      }

      return peak;
    });
    const loudest = Math.max(...peaks) || 1;

    return {
      peaks: peaks.map((peak) => Math.max(0.08, peak / loudest)),
      seconds: audio.duration,
    };
  } finally {
    void context.close();
  }
}

/**
 * A voice note as a messaging app plays it: play and pause, the waveform filling in as it
 * plays and taking a click or a drag to jump, the time, and the speed. The native element does
 * the playing; this is only its face.
 */
export function AudioPlayer({ src, label = 'Audio' }: { src: string; label?: string }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [bars, setBars] = useState<number[]>(() => Array(BARS).fill(0.3));

  useEffect(() => {
    let stopped = false;

    void waveform(src)
      .then(({ peaks, seconds }) => {
        if (stopped) return;
        setBars(peaks);
        setDuration((known) => (Number.isFinite(known) && known > 0 ? known : seconds));
      })
      .catch(() => {});

    return () => {
      stopped = true;
    };
  }, [src]);

  const progress = duration ? time / duration : 0;

  return (
    <div className="audio-player">
      {/* biome-ignore lint/a11y/useMediaCaption: speech the agent can transcribe on request; no caption track exists. */}
      <audio
        ref={audio}
        src={src}
        preload="metadata"
        onDurationChange={(event) => {
          const seconds = event.currentTarget.duration;

          if (Number.isFinite(seconds)) setDuration(seconds);
        }}
        onTimeUpdate={(event) => setTime(event.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
      />
      <button
        type="button"
        className="audio-toggle"
        aria-label={playing ? `Pause ${label}` : `Play ${label}`}
        onClick={() => (playing ? audio.current?.pause() : void audio.current?.play())}
      >
        {playing ? <Pause size={16} /> : <Play size={16} className="translate-x-px" />}
      </button>
      <div className="audio-track">
        <div className="audio-bars" aria-hidden="true">
          {bars.map((height, index) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: bars are positions, never reordered.
              key={index}
              style={{ height: `${Math.round(height * 100)}%` }}
              data-played={index / BARS < progress}
            />
          ))}
        </div>
        <input
          type="range"
          aria-label={`Position in ${label}`}
          min={0}
          max={duration || 0}
          step={0.1}
          value={time}
          onChange={(event) => {
            const next = Number(event.target.value);

            if (audio.current) audio.current.currentTime = next;
            setTime(next);
          }}
        />
      </div>
      <span className="audio-time">{clock(playing || time ? time : duration)}</span>
      <button
        type="button"
        className="audio-speed"
        aria-label={`Playback speed ${speed}×`}
        onClick={() => {
          const next = speeds[(speeds.indexOf(speed) + 1) % speeds.length] ?? 1;

          if (audio.current) audio.current.playbackRate = next;
          setSpeed(next);
        }}
      >
        {speed}×
      </button>
    </div>
  );
}
