'use client';

import { ArrowUp, FileText, LoaderCircle, Plus, Reply, Trash2, X } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import type { MediaUpload } from '../../lib/api';
import {
  type AttachmentKind,
  base64,
  classify,
  MAX_MESSAGE_MEDIA,
  PASTE_AS_FILE_CHARS,
} from '../../lib/attachments';
import { useRecorder } from '../../lib/recorder';
import { useDrafts } from '../../lib/stores/drafts';
import { AudioPlayer } from '../ui';
import { listBreak } from './list-break';
import { size } from './media';
import { VoicePill } from './voice-pill';

type Attachment = {
  key: string;
  name: string;
  kind: AttachmentKind;
  bytes: number;
  /** A local address for the picture or the recording, released when the tile goes. */
  preview?: string;
  state: 'uploading' | 'ready' | 'failed';
  id?: string;
  file?: File;
  mimeType?: MediaUpload['mimeType'];
  voice?: boolean;
};

/**
 * The owner's side of the gateway conversation. Each file uploads the moment it is attached,
 * so sending only names what is already there. Enter sends and Shift+Enter breaks the line; the
 * text and the files stay until the gateway accepts the message, so a failed send loses nothing.
 */
export function Composer({
  draftKey,
  name,
  upload,
  send,
  onSent,
  placeholder,
  draft = false,
  modelControl,
  status,
  replyTo,
  onCancelReply,
}: {
  name: string;
  upload: (file: MediaUpload) => Promise<{ id: string }>;
  /** Where what is being written is kept until it is sent, across pages and restarts. */
  draftKey?: string;
  send: (text: string, mediaIds: string[], replyToId?: string) => Promise<unknown>;
  replyTo?: { id: string; content: string };
  onCancelReply?: () => void;
  onSent: () => void;
  placeholder?: string;
  draft?: boolean;
  modelControl?: ReactNode;
  /** Where the conversation's objective and listeners stand, at the end of the row above it. */
  status?: ReactNode;
}) {
  const [text, setText] = useState(() =>
    draftKey ? (useDrafts.getState().texts[draftKey] ?? '') : '',
  );
  const write = (next: string) => {
    setText(next);
    if (draftKey) useDrafts.getState().write(draftKey, next);
  };
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const editor = useRef<HTMLTextAreaElement>(null);
  const still = useReducedMotion();
  useEffect(() => {
    if (replyTo) editor.current?.focus();
  }, [replyTo]);
  const recorder = useRecorder();
  const pastes = useRef(0);
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
        state: draft ? 'ready' : 'uploading',
        ...(preview ? { preview } : {}),
        ...(draft
          ? {
              file,
              mimeType: verdict.mimeType as MediaUpload['mimeType'],
              ...(voice ? { voice: true } : {}),
            }
          : {}),
      };

      if (preview) previews.current.add(preview);
      if (!draft) {
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
      }

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
      const mediaIds = await Promise.all(
        ready.map(async (item) => {
          if (item.id) return item.id;
          if (!draft || !item.file || !item.mimeType) {
            throw new Error(`Could not upload ${item.name}. Remove it and try again.`);
          }
          const media = await upload({
            mimeType: item.mimeType,
            data: await base64(item.file),
            name: item.name,
            ...(item.voice ? { voice: true } : {}),
          });
          patch(item.key, { state: 'ready', id: media.id, file: undefined });
          return media.id;
        }),
      );
      if (replyTo) await send(text.trim(), mediaIds, replyTo.id);
      else await send(text.trim(), mediaIds);
      onCancelReply?.();
      for (const item of attachments) if (item.preview) URL.revokeObjectURL(item.preview);
      previews.current.clear();
      write('');
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
      {status && <div className="composer-context">{status}</div>}
      <AnimatePresence initial={false}>
        {replyTo && (
          <motion.div
            key="reply"
            className="composer-reply-shell"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: still ? 0 : 0.18, ease: 'easeOut' }}
          >
            <div className="composer-reply" role="status">
              <Reply size={15} aria-hidden="true" />
              <div>
                <strong>Replying to {name}</strong>
                <span>
                  {replyTo.content
                    .replace(/\[Attached media: [0-9a-f-]{36}\]/g, '')
                    .slice(0, 300) || 'Attachment'}
                </span>
              </div>
              <button type="button" aria-label="Cancel reply" onClick={onCancelReply}>
                <X size={15} />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <div className="composer-box" data-dragging={dragging}>
        {attachments.length > 0 && (
          <ul className="composer-attachments" aria-label="Attachments">
            {attachments.map((item) => (
              <li key={item.key} className={`attachment ${item.kind}`} data-state={item.state}>
                {item.kind === 'image' && item.preview ? (
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
            Recording a voice note
          </div>
        ) : (
          <textarea
            ref={editor}
            aria-label={`Message to ${name}`}
            placeholder={placeholder ?? 'Ask anything'}
            rows={1}
            maxLength={8000}
            value={text}
            onChange={(event) => write(event.target.value)}
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
              if (
                event.key === 'Enter' &&
                event.shiftKey &&
                !event.nativeEvent.isComposing &&
                !event.ctrlKey &&
                !event.metaKey &&
                !event.altKey
              ) {
                const field = event.currentTarget;
                const next = listBreak(text, field.selectionStart, field.selectionEnd);
                if (next && next.text.length <= field.maxLength) {
                  event.preventDefault();
                  write(next.text);
                  requestAnimationFrame(() => field.setSelectionRange(next.caret, next.caret));
                }
                return;
              }
              // A touch keyboard has no Shift to hold, so there Return breaks the line and the
              // button sends.
              if (
                event.key === 'Enter' &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing &&
                !window.matchMedia?.('(pointer: coarse)').matches
              ) {
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
              <Trash2 size={16} />
            </button>
          ) : (
            <>
              <button
                type="button"
                className="composer-tool"
                aria-label="Attach files"
                onClick={() => picker.current?.click()}
              >
                <Plus size={16} />
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
          {/* Beside the other way to add to a message; recording, it grows to its left. */}
          <VoicePill
            listening={recorder.recording}
            stream={recorder.stream}
            onStart={() => void record()}
            // Sliding away and Escape mean no; every other way of stopping keeps the note.
            onStop={(reason) =>
              reason === 'cancel' || reason === 'escape' ? recorder.cancel() : void finish()
            }
          />
          <span className="grow" />
          {modelControl}
          <button type="submit" className="composer-send" aria-label="Send" disabled={!canSend}>
            <ArrowUp size={16} />
          </button>
        </div>
      </div>
    </form>
  );
}
