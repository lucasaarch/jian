'use client';

import { Popover } from '@base-ui/react/popover';
import { reactionEmojiSchema } from '@jian/contracts';
import { Check, Copy, Reply, SmilePlus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { HoverTip } from '../../kit';
import type { Message } from '../../lib/api';

const quick = ['👍', '👎', '❤️', '😂', '🎉'];
const extra = [
  '😊',
  '😍',
  '🥰',
  '🤔',
  '😮',
  '😢',
  '😭',
  '🙏',
  '🔥',
  '💯',
  '👏',
  '💪',
  '✅',
  '🚀',
  '👀',
  '🤝',
  '✨',
  '🙌',
];

/** The popover stays reachable after hover ends and each message owns its own pending action. */
export function MessageActions({
  message,
  onReply,
  onReact,
}: {
  message: Message;
  onReply?: () => void;
  onReact?: (emoji: string | null) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const selected = message.reactions?.find((reaction) => reaction.actor === 'owner')?.emoji;
  const react = async (emoji: string) => {
    if (busy || !onReact) return;
    if (!reactionEmojiSchema.safeParse(emoji).success) {
      toast.error('Choose one emoji.');
      return;
    }
    setBusy(true);
    try {
      await onReact(emoji === selected ? null : emoji);
      setOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The reaction could not be saved.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <fieldset className="message-tools" data-open={open || undefined} aria-label="Message actions">
      {onReact && (
        <Popover.Root open={open} onOpenChange={setOpen}>
          <HoverTip tip={selected ? 'Change reaction' : 'React'}>
            <Popover.Trigger
              className="message-tool"
              data-persistent={selected || undefined}
              aria-label="React to message"
            >
              {selected ? (
                <span className="message-tool-emoji">{selected}</span>
              ) : (
                <SmilePlus size={14} />
              )}
            </Popover.Trigger>
          </HoverTip>
          <Popover.Portal>
            <Popover.Positioner side="bottom" align="start" sideOffset={8} className="z-50">
              <Popover.Popup className="reaction-picker">
                <Popover.Title className="sr-only">React to message</Popover.Title>
                <div className="reaction-quick">
                  {quick.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      aria-label={`React ${emoji}`}
                      aria-pressed={selected === emoji}
                      disabled={busy}
                      onClick={() => void react(emoji)}
                    >
                      {emoji}
                    </button>
                  ))}
                  <button
                    type="button"
                    aria-label="More reactions"
                    aria-expanded={more}
                    onClick={() => setMore((value) => !value)}
                  >
                    <SmilePlus size={17} />
                  </button>
                </div>
                {more && (
                  <div className="reaction-grid">
                    {extra.map((emoji) => (
                      <button
                        key={emoji}
                        type="button"
                        aria-label={`React ${emoji}`}
                        aria-pressed={selected === emoji}
                        disabled={busy}
                        onClick={() => void react(emoji)}
                      >
                        {emoji}
                      </button>
                    ))}
                  </div>
                )}
              </Popover.Popup>
            </Popover.Positioner>
          </Popover.Portal>
        </Popover.Root>
      )}
      {onReply && (
        <HoverTip tip="Reply">
          <button
            type="button"
            className="message-tool"
            aria-label="Reply to message"
            onClick={onReply}
          >
            <Reply size={14} />
          </button>
        </HoverTip>
      )}
      <HoverTip tip={copied ? 'Copied' : 'Copy'}>
        <button
          type="button"
          className="message-tool"
          aria-label="Copy message"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(
                message.content.replace(/\[Attached media: [0-9a-f-]{36}\]/g, '').trim(),
              );
              setCopied(true);
              clearTimeout(timer.current);
              timer.current = setTimeout(() => setCopied(false), 1500);
            } catch {
              toast.error('The message could not be copied.');
            }
          }}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </HoverTip>
    </fieldset>
  );
}

export function MessageReactions({
  message,
  agentName = 'Agent',
}: {
  message: Message;
  agentName?: string;
}) {
  const reactions = message.reactions?.filter((reaction) => reaction.actor === 'agent') ?? [];
  if (!reactions.length) return null;
  return (
    <div className="message-reactions" role="status" aria-label="Message reactions">
      {reactions.map((reaction) => (
        <span
          key={reaction.actor}
          className="reaction-badge"
          role="img"
          title={`${agentName} reacted ${reaction.emoji}`}
          aria-label={`${agentName} reacted ${reaction.emoji}`}
        >
          {reaction.emoji}
        </span>
      ))}
    </div>
  );
}
