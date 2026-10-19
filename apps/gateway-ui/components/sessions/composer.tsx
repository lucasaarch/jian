'use client';

import {
  ArrowUp,
  FileText,
  LoaderCircle,
  Mic,
  Phone,
  PhoneOff,
  Plus,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { MediaUpload } from '../../lib/api';
import {
  type AttachmentKind,
  base64,
  classify,
  MAX_MESSAGE_MEDIA,
  PASTE_AS_FILE_CHARS,
} from '../../lib/attachments';
import { useRecorder } from '../../lib/recorder';
import { AudioPlayer } from '../ui';
import { connectLiveVoice } from './live-voice';
import { size } from './media';

type Attachment = {
  key: string;
  name: string;
  kind: AttachmentKind;
  bytes: number;
  /** A local address for the picture or the recording, released when the tile goes. */
  preview?: string;
  state: 'uploading' | 'ready' | 'failed';
  id?: string;
};

const clock = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;

/**
 * The owner's side of the gateway conversation. Each file uploads the moment it is attached,
 * so sending only names what is already there. Enter sends and Shift+Enter breaks the line; the
 * text and the files stay until the gateway accepts the message, so a failed send loses nothing.
 */
export function Composer({
  name,
  upload,
  send,
  createVoiceToken,
  summarizeVoiceTranscript,
  onSent,
  placeholder,
}: {
  name: string;
  upload: (file: MediaUpload) => Promise<{ id: string }>;
  send: (text: string, mediaIds: string[]) => Promise<unknown>;
  createVoiceToken: () => Promise<{
    token: string;
    model: string;
    provider: 'google' | 'openai';
    voiceName?: string;
  }>;
  summarizeVoiceTranscript: (transcript: string) => Promise<{ summary: string }>;
  onSent: () => void;
  placeholder?: string;
}) {
  const [live, setLive] = useState(false);
  const [liveBusy, setLiveBusy] = useState(false);
  const liveSession = useRef<{ close: () => void } | undefined>(undefined);
  // Interim/final text is held only in memory for the later summary step; never uploaded here.
  const liveTranscript = useRef<string[]>([]);
  const liveStartedAt = useRef(0);
  const liveLabel = useRef('Gemini Live');

  const toggleLive = async () => {
    if (liveBusy) return;
    if (liveSession.current) {
      liveSession.current.close();
      liveSession.current = undefined;
      setLive(false);
      setLiveBusy(true);
      try {
        const transcript = liveTranscript.current.join(' ').slice(0, 20_000);
        liveTranscript.current = [];
        if (!transcript.trim()) return;
        const { summary } = await summarizeVoiceTranscript(transcript);
        const duration = Math.max(1, Math.round((Date.now() - liveStartedAt.current) / 1000));
        await send(`[Voice call · ${clock(duration)} · ${liveLabel.current}]\n${summary}`, []);
        onSent();
      } catch (failure) {
        setError(
          failure instanceof Error ? failure.message : 'Could not save the voice-call summary.',
        );
      } finally {
        setLiveBusy(false);
      }
      return;
    }
    setLiveBusy(true);
    try {
      setError('');
      const { token, model, provider, voiceName } = await createVoiceToken();
      liveLabel.current = provider === 'openai' ? 'OpenAI Live' : 'Gemini Live';
      liveTranscript.current = [];
      liveStartedAt.current = Date.now();
      liveSession.current = await connectLiveVoice(
        token,
        model,
        (text) => {
          const room = 20_000 - liveTranscript.current.join(' ').length;
          if (room > 0) liveTranscript.current.push(text.slice(0, room));
        },
        voiceName,
      );
      setLive(true);
    } catch (failure) {
      liveSession.current?.close();
      liveSession.current = undefined;
      liveTranscript.current = [];
      setError(failure instanceof Error ? failure.message : 'Could not start the voice call.');
    } finally {
      setLiveBusy(false);
    }
  };

  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const recorder = useRecorder();
  const pastes = useRef(0);

  useEffect(() => () => liveSession.current?.close(), []);

  // Local previews hold memory until released; the last ones go with the composer.
  const previews = useRef(new Set<string>());
  useEffect(
    () => () => {
      for (const url of previews.current) URL.revokeObjectURL(url);
    },
    [],
  );

  const patch = (key: string, change: Partial<Attachment>) =>
    setAttachments((list) =>
      list.map((item) => (item.key === key ? { ...item, ...change } : item)),
    );

  const attach = (files: File[], voice = false) => {
    const room = MAX_MESSAGE_MEDIA - attachments.length;
    const problems: string[] = [];

    if (files.length > room) problems.push(`A message carries at most ${MAX_MESSAGE_MEDIA} files.`);

    const added = files.slice(0, Math.max(room, 0)).flatMap((file) => {
      const verdict = classify(file);

      if ('error' in verdict) {
        problems.push(verdict.error);
        return [];
      }

      const preview = verdict.kind === 'document' ? undefined : URL.createObjectURL(file);
      const item: Attachment = {
        key: crypto.randomUUID(),
        name: file.name,
        kind: verdict.kind,
        bytes: file.size,
        state: 'uploading',
        ...(preview ? { preview } : {}),
      };

      if (preview) previews.current.add(preview);
      void base64(file)
        .then((data) =>
          upload({
            mimeType: verdict.mimeType as MediaUpload['mimeType'],
            data,
            name: file.name,
            ...(voice ? { voice: true } : {}),
          }),
        )
        .then((media) => patch(item.key, { state: 'ready', id: media.id }))
        .catch(() => patch(item.key, { state: 'failed' }));

      return [item];
    });

    setError(problems.join(' '));
    setAttachments((list) => [...list, ...added]);
  };

  const remove = (key: string) =>
    setAttachments((list) =>
      list.filter((item) => {
        if (item.key !== key) return true;
        if (item.preview) {
          URL.revokeObjectURL(item.preview);
          previews.current.delete(item.preview);
        }
        return false;
      }),
    );

  const ready = attachments.filter((item) => item.state === 'ready');
  const uploading = attachments.some((item) => item.state === 'uploading');
  const canSend =
    !sending && !uploading && !recorder.recording && Boolean(text.trim() || ready.length);

  const submit = async () => {
    if (!canSend) return;
    setSending(true);
    setError('');
    try {
      await send(
        text.trim(),
        ready.map((item) => item.id ?? ''),
      );
      for (const item of attachments) if (item.preview) URL.revokeObjectURL(item.preview);
      previews.current.clear();
      setText('');
      setAttachments([]);
      onSent();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The message could not be sent.');
    } finally {
      setSending(false);
    }
  };

  const record = async () => {
    try {
      await recorder.start();
      setError('');
    } catch {
      setError('The microphone is not available. Allow it in the browser to record.');
    }
  };

  const finish = async () => {
    const audio = await recorder.stop();

    if (!audio) return;
    const extension = audio.type.includes('mp4')
      ? 'm4a'
      : audio.type.includes('ogg')
        ? 'ogg'
        : 'webm';

    attach([new File([audio], `Voice note.${extension}`, { type: audio.type })], true);
  };

  return (
    <form
      className="composer"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        if (!event.dataTransfer.files.length) return;
        event.preventDefault();
        setDragging(false);
        attach([...event.dataTransfer.files]);
      }}
    >
      {error && (
        <p className="composer-error" role="alert">
          {error}
        </p>
      )}
      <div className="composer-box" data-dragging={dragging}>
        {attachments.length > 0 && (
          <ul className="composer-attachments" aria-label="Attachments">
            {attachments.map((item) => (
              <li key={item.key} className={`attachment ${item.kind}`} data-state={item.state}>
                {item.kind === 'image' && item.preview ? (
                  // biome-ignore lint/performance/noImgElement: a local preview of a file not yet sent.
                  <img src={item.preview} alt={item.name} />
                ) : item.kind === 'audio' && item.preview ? (
                  <AudioPlayer src={item.preview} label={item.name} />
                ) : (
                  <span className="attachment-file">
                    <span className="file-icon" aria-hidden="true">
                      <FileText size={16} />
                    </span>
                    <span className="file-text">
                      <strong>{item.name}</strong>
                      <small>{item.state === 'failed' ? 'Upload failed' : size(item.bytes)}</small>
                    </span>
                  </span>
                )}
                {item.state === 'uploading' && (
                  <span
                    className="attachment-busy"
                    role="status"
                    aria-label={`Uploading ${item.name}`}
                  >
                    <LoaderCircle size={16} className="spin" />
                  </span>
                )}
                <button
                  type="button"
                  className="attachment-remove"
                  aria-label={`Remove ${item.name}`}
                  onClick={() => remove(item.key)}
                >
                  <X size={12} />
                </button>
              </li>
            ))}
          </ul>
        )}
        {recorder.recording ? (
          <div className="composer-recording" role="status">
            <span className="recording-dot" aria-hidden="true" />
            Recording {clock(recorder.seconds)}
          </div>
        ) : (
          <textarea
            aria-label={`Message to ${name}`}
            placeholder={placeholder ?? `Message ${name}`}
            rows={1}
            maxLength={8000}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onPaste={(event) => {
              const files = [...event.clipboardData.files];

              if (files.length) {
                event.preventDefault();
                attach(files);
                return;
              }

              const pasted = event.clipboardData.getData('text/plain');

              if (pasted.length > PASTE_AS_FILE_CHARS) {
                event.preventDefault();
                pastes.current += 1;
                attach([
                  new File(
                    [pasted],
                    pastes.current === 1
                      ? 'Pasted Content.txt'
                      : `Pasted Content ${pastes.current}.txt`,
                    { type: 'text/plain' },
                  ),
                ]);
              }
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void submit();
              }
            }}
          />
        )}
        <div className="composer-actions">
          {recorder.recording ? (
            <button
              type="button"
              className="composer-tool"
              aria-label="Discard the recording"
              onClick={recorder.cancel}
            >
              <Trash2 size={18} />
            </button>
          ) : (
            <>
              <button
                type="button"
                className="composer-tool"
                aria-label="Attach files"
                onClick={() => picker.current?.click()}
              >
                <Plus size={18} />
              </button>
              <input
                ref={picker}
                type="file"
                multiple
                hidden
                onChange={(event) => {
                  attach([...(event.target.files ?? [])]);
                  event.target.value = '';
                }}
              />
            </>
          )}
          <button
            type="button"
            className={`composer-tool ${live ? 'recording' : ''}`}
            aria-label={live ? 'End voice call' : 'Start voice call'}
            title={
              live
                ? 'End voice call'
                : 'Start a Live voice call (needs a Gemini Live model under Voice calls)'
            }
            disabled={liveBusy}
            onClick={() => void toggleLive()}
          >
            {live ? <PhoneOff size={16} /> : <Phone size={16} />}
          </button>
          <span className="grow" />
          {recorder.recording ? (
            <button
              type="button"
              className="composer-tool recording"
              aria-label="Stop recording"
              onClick={() => void finish()}
            >
              <Square size={14} fill="currentColor" />
            </button>
          ) : (
            <button
              type="button"
              className="composer-tool"
              aria-label="Record a voice note"
              onClick={() => void record()}
            >
              <Mic size={18} />
            </button>
          )}
          <button type="submit" className="composer-send" aria-label="Send" disabled={!canSend}>
            {sending ? <LoaderCircle size={18} className="spin" /> : <ArrowUp size={18} />}
          </button>
        </div>
      </div>
    </form>
  );
}
