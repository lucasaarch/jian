'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/** Containers the gateway accepts, in the order browsers record best: Chrome and Firefox, Safari. */
const formats = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];

/**
 * A voice note from the microphone. `stop` resolves with the recording, `cancel` throws it away;
 * either one releases the microphone, so the browser's recording light goes out with it.
 */
export function useRecorder() {
  const recorder = useRef<MediaRecorder>(null);
  const chunks = useRef<Blob[]>([]);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);

  const release = useCallback(() => {
    for (const track of recorder.current?.stream.getTracks() ?? []) track.stop();
    recorder.current = null;
    setRecording(false);
  }, []);

  useEffect(() => {
    if (!recording) return;
    const started = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 250);

    return () => clearInterval(timer);
  }, [recording]);

  // Leaving the screen mid-recording must not leave the microphone on.
  useEffect(() => release, [release]);

  const start = useCallback(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = formats.find((format) => MediaRecorder.isTypeSupported(format));
    const next = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

    chunks.current = [];
    next.ondataavailable = (event) => {
      if (event.data.size) chunks.current.push(event.data);
    };
    next.start(250);
    recorder.current = next;
    setSeconds(0);
    setRecording(true);
  }, []);

  const stop = useCallback(
    () =>
      new Promise<Blob | undefined>((resolve) => {
        const current = recorder.current;

        if (!current) return resolve(undefined);
        current.onstop = () => {
          resolve(new Blob(chunks.current, { type: current.mimeType }));
          release();
        };
        current.stop();
      }),
    [release],
  );

  const cancel = useCallback(() => {
    if (recorder.current) recorder.current.onstop = null;
    recorder.current?.stop();
    release();
  }, [release]);

  return { recording, seconds, start, stop, cancel };
}
