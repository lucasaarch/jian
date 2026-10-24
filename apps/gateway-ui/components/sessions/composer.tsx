'use client';

import { ArrowUp, Bot, FileText, LoaderCircle, Mic, Plus, Square, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { MediaUpload, ModelSelection, Profile, ProviderModelList } from '../../lib/api';
import {
  type AttachmentKind,
  base64,
  classify,
  MAX_MESSAGE_MEDIA,
  PASTE_AS_FILE_CHARS,
} from '../../lib/attachments';
import { useRecorder } from '../../lib/recorder';
import { efforts } from '../providers/catalog';
import { AudioPlayer } from '../ui';
import { Select } from '../ui/select';
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
  profileId,
  agents,
  sessionId,
  model,
  providerModels,
  resolveAgent,
  upload,
  send,
  onSent,
  placeholder,
}: {
  name: string;
  profileId: string;
  agents: Profile[];
  sessionId: string;
  model?: ModelSelection;
  providerModels: Record<string, ProviderModelList>;
  resolveAgent: (profileId: string) => Promise<{ sessionId: string; model?: ModelSelection }>;
  upload: (profileId: string, sessionId: string, file: MediaUpload) => Promise<{ id: string }>;
  send: (
    profileId: string,
    sessionId: string,
    text: string,
    mediaIds: string[],
    model?: ModelSelection,
  ) => Promise<unknown>;
  onSent: (profileId: string) => void;
  placeholder?: string;
}) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [dragging, setDragging] = useState(false);
  const [agentId, setAgentId] = useState(profileId);
  const [targetSessionId, setTargetSessionId] = useState(sessionId);
  const [targetModel, setTargetModel] = useState(model);
  const [targetLoading, setTargetLoading] = useState(false);
  const [reasoningEffort, setReasoningEffort] = useState(model?.reasoningEffort ?? '');
  const picker = useRef<HTMLInputElement>(null);
  const recorder = useRecorder();
  const pastes = useRef(0);

  useEffect(() => {
    let current = true;
    if (agentId === profileId) {
      setTargetSessionId(sessionId);
      setTargetModel(model);
      setReasoningEffort(model?.reasoningEffort ?? '');
      setTargetLoading(false);
      return;
    }
    setTargetLoading(true);
    setTargetSessionId('');
    void resolveAgent(agentId)
      .then((target) => {
        if (!current) return;
        setTargetSessionId(target.sessionId);
        setTargetModel(target.model);
        setReasoningEffort(target.model?.reasoningEffort ?? '');
        setError('');
      })
      .catch((failure: unknown) => {
        if (current)
          setError(failure instanceof Error ? failure.message : 'Could not open this agent.');
      })
      .finally(() => {
        if (current) setTargetLoading(false);
      });
    return () => {
      current = false;
    };
  }, [agentId, model, profileId, resolveAgent, sessionId]);

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
    if (targetLoading || !targetSessionId) {
      setError('Wait for the selected agent to load before attaching files.');
      return;
    }
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
          upload(agentId, targetSessionId, {
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
  const selectedAgent = agents.find((agent) => agent.id === agentId);
  const listedModel = targetModel
    ? providerModels[targetModel.providerId]?.models.find((item) => item.id === targetModel.modelId)
    : undefined;
  const availableEfforts = efforts.filter((effort) =>
    listedModel?.reasoningEfforts.includes(effort.value),
  );
  const canSend =
    !sending &&
    !targetLoading &&
    Boolean(targetSessionId) &&
    !uploading &&
    !recorder.recording &&
    Boolean(text.trim() || ready.length);

  const submit = async () => {
    if (!canSend) return;
    setSending(true);
    setError('');
    try {
      const selectedModel = targetModel
        ? {
            providerId: targetModel.providerId,
            modelId: targetModel.modelId,
            ...(reasoningEffort
              ? { reasoningEffort: reasoningEffort as ModelSelection['reasoningEffort'] }
              : {}),
          }
        : undefined;
      await send(
        agentId,
        targetSessionId,
        text.trim(),
        ready.map((item) => item.id ?? ''),
        selectedModel,
      );
      for (const item of attachments) if (item.preview) URL.revokeObjectURL(item.preview);
      previews.current.clear();
      setText('');
      setAttachments([]);
      onSent(agentId);
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
            aria-label={`Message to ${selectedAgent?.name ?? name}`}
            placeholder={placeholder ?? `Message ${selectedAgent?.name ?? name}`}
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
          <span className="grow" />
          <Select
            aria-label="Agent for this message"
            className="composer-select composer-agent-select"
            value={agentId}
            disabled={
              sending || targetLoading || uploading || attachments.length > 0 || recorder.recording
            }
            onValueChange={setAgentId}
            searchThreshold={5}
            options={agents.map((agent) => ({
              value: agent.id,
              label: agent.name,
              detail: agent.professionId ?? undefined,
              icon: <Bot size={15} />,
            }))}
          />
          <Select
            aria-label="Reasoning effort for this message"
            className="composer-select composer-effort-select"
            value={reasoningEffort}
            disabled={sending || targetLoading || !targetModel || availableEfforts.length === 0}
            onValueChange={setReasoningEffort}
            options={[{ value: '', label: 'Default effort' }, ...availableEfforts]}
          />
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
              disabled={targetLoading}
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
