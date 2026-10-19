'use client';

/** Direct browser-to-Gemini Live audio. Only the short-lived, single-use token reaches the browser. */
export async function connectLiveVoice(
  token: string,
  model: string,
  onTranscript: (text: string) => void = () => {},
) {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const context = new AudioContext();
  const socket = new WebSocket(
    `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?access_token=${encodeURIComponent(token)}`,
  );
  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(2048, 1, 1);
  const silence = context.createGain();
  silence.gain.value = 0;
  source.connect(processor);
  processor.connect(silence);
  silence.connect(context.destination);

  const ready = new Promise<void>((resolve, reject) => {
    socket.addEventListener(
      'open',
      () => {
        socket.send(
          JSON.stringify({
            setup: {
              model: model.startsWith('models/') ? model : `models/${model}`,
              generationConfig: { responseModalities: ['AUDIO'] },
              inputAudioTranscription: {},
              outputAudioTranscription: {},
            },
          }),
        );
      },
      { once: true },
    );
    socket.addEventListener('message', async (event) => {
      const data = JSON.parse(String(event.data));
      if (data.setupComplete) resolve();
      const transcript =
        data.serverContent?.inputTranscription?.text ??
        data.serverContent?.outputTranscription?.text;
      if (typeof transcript === 'string' && transcript) onTranscript(transcript);
      for (const part of data.serverContent?.modelTurn?.parts ?? []) {
        const encoded = part.inlineData?.data;
        if (!encoded) continue;
        const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
        const pcm = new Int16Array(
          bytes.buffer,
          bytes.byteOffset,
          Math.floor(bytes.byteLength / 2),
        );
        const buffer = context.createBuffer(1, pcm.length, 24000);
        const channel = buffer.getChannelData(0);
        for (let index = 0; index < pcm.length; index++) channel[index] = (pcm[index] ?? 0) / 32768;
        const player = context.createBufferSource();
        player.buffer = buffer;
        player.connect(context.destination);
        playbackAt = Math.max(playbackAt, context.currentTime);
        player.start(playbackAt);
        playbackAt += buffer.duration;
      }
    });
    socket.addEventListener('error', () => reject(new Error('Gemini Live connection failed')), {
      once: true,
    });
  });
  try {
    await ready;
  } catch (error) {
    processor.disconnect();
    source.disconnect();
    silence.disconnect();
    for (const track of stream.getTracks()) track.stop();
    socket.close();
    void context.close();
    throw error;
  }

  let playbackAt = context.currentTime;
  processor.onaudioprocess = (event) => {
    if (socket.readyState !== WebSocket.OPEN) return;
    const input = event.inputBuffer.getChannelData(0);
    const ratio = context.sampleRate / 16000;
    const count = Math.floor(input.length / ratio);
    const pcm = new Int16Array(count);
    for (let i = 0; i < count; i++) {
      const sample = input[Math.floor(i * ratio)] ?? 0;
      pcm[i] = Math.max(-1, Math.min(1, sample)) * 32767;
    }
    const bytes = new Uint8Array(pcm.buffer);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    socket.send(
      JSON.stringify({
        realtimeInput: { audio: { data: btoa(binary), mimeType: 'audio/pcm;rate=16000' } },
      }),
    );
  };

  return {
    close() {
      processor.disconnect();
      source.disconnect();
      silence.disconnect();
      for (const track of stream.getTracks()) track.stop();
      socket.close();
      void context.close();
    },
  };
}
