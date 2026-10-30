'use client';

import { Popover } from '@base-ui/react/popover';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Action } from '../../kit';
import type { SessionContext } from '../../lib/api';
import { ago } from '../../lib/format';
import { queries } from '../../lib/query/profile';

/** Past this share of the room the ring warns; the gateway compacts at `compactAt`, near 85%. */
const NEAR = 0.6;

const counted = (value: number) =>
  value < 1000
    ? String(Math.round(value))
    : new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value);

/** How full, as the ring draws it: quiet, then amber, then red once it is where compaction starts. */
function toneOf(context: SessionContext | undefined) {
  if (!context?.used) return { share: 0, colour: 'var(--muted)' };
  const share = Math.min(1, context.used / context.limit);
  const colour =
    context.used >= context.compactAt ? 'var(--bad)' : share >= NEAR ? 'var(--warn)' : 'var(--ink)';
  return { share, colour };
}

/** A ring filled as far as the context is, `size` pixels across with a stroke to match. */
function Ring({ share, colour, size }: { share: number; colour: string; size: number }) {
  const stroke = size >= 20 ? 2.5 : 2;
  const radius = (size - stroke) / 2;
  const around = 2 * Math.PI * radius;
  const centre = size / 2;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden="true"
      className="-rotate-90"
    >
      <circle
        cx={centre}
        cy={centre}
        r={radius}
        fill="none"
        stroke="var(--glass-edge)"
        strokeWidth={stroke}
      />
      <circle
        cx={centre}
        cy={centre}
        r={radius}
        fill="none"
        stroke={colour}
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={around}
        strokeDashoffset={around * (1 - share)}
        className="transition-[stroke-dashoffset,stroke] duration-500 ease-out"
      />
    </svg>
  );
}

function Line({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-muted">{label}</dt>
      <dd className="m-0 text-right text-ink tabular-nums">{children}</dd>
    </div>
  );
}

/**
 * How full this conversation's context is, beside its protection: a ring that fills and turns
 * amber, then red where the gateway compacts on its own. Opened, it tells the last call's input
 * against the room, what the conversation's turns have cost, the last compaction, and offers to
 * compact now — `compact`, where the conversation can be written in from here. A conversation
 * not started yet has it too, empty, so the composer reads the same before and after.
 */
export function ContextRing({
  profileId,
  sessionId,
  compact,
}: {
  profileId: string;
  /** None for a conversation not started yet: the ring waits empty for its first answer. */
  sessionId?: string | undefined;
  compact?: () => Promise<unknown>;
}) {
  const context = useQuery({
    ...queries.sessionContext(profileId, sessionId ?? ''),
    enabled: Boolean(sessionId),
  }).data;
  const [open, setOpen] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const tone = toneOf(context);
  const percent = Math.round(tone.share * 100);
  const said = context?.used == null ? 'Context: nothing measured yet' : `Context ${percent}% full`;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      {/* As wide as it is tall, 32 pixels at most like the controls beside it, the ring inset
          in it and the same hover behind it as theirs. */}
      <Popover.Trigger
        className="model-trigger size-8 justify-center p-1.5"
        aria-label={said}
        title={said}
      >
        <Ring {...tone} size={18} />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" align="start" sideOffset={8} className="z-50">
          <Popover.Popup className="glass grid w-72 origin-(--transform-origin) gap-3 rounded-2xl p-4 text-[13px] text-ink outline-none transition-[opacity,scale] duration-150 data-ending-style:scale-[0.97] data-ending-style:opacity-0 data-starting-style:scale-[0.97] data-starting-style:opacity-0">
            <header className="flex items-center gap-3">
              <Ring {...tone} size={28} />
              <div className="grid min-w-0 gap-0.5">
                <Popover.Title className="text-sm font-semibold">Context</Popover.Title>
                <p className="truncate text-xs text-muted">
                  {context?.used == null
                    ? 'Measured from the first answer here.'
                    : `${counted(context.used)} of ${counted(context.limit)} tokens · ${percent}%`}
                </p>
              </div>
            </header>
            {context && (
              <>
                <p className="text-xs leading-relaxed text-muted">
                  Older turns become a summary on their own past {counted(context.compactAt)}{' '}
                  tokens.
                  {context.model
                    ? ` ${context.model.modelId} holds ${counted(context.window)}.`
                    : ''}
                </p>
                <dl className="m-0 grid gap-1.5 border-t border-glass-edge pt-3">
                  <Line label="Input">
                    {counted(context.totals.inputTokens)}
                    {context.totals.cachedInputTokens > 0 && (
                      <span className="text-muted">
                        {' '}
                        · {counted(context.totals.cachedInputTokens)} cached
                      </span>
                    )}
                  </Line>
                  <Line label="Output">{counted(context.totals.outputTokens)}</Line>
                  <Line label="Turns">{context.totals.turns}</Line>
                  <Line label="Last compacted">
                    {context.compacted
                      ? `${ago(context.compacted.at)} · ${counted(context.compacted.beforeTokens)} → ${counted(context.compacted.afterTokens)}`
                      : 'Not yet'}
                  </Line>
                </dl>
              </>
            )}
            {compact && (
              <Action
                tone="outline"
                size="small"
                busy={compacting}
                className="justify-self-start"
                onClick={async () => {
                  setCompacting(true);
                  try {
                    await compact();
                    setOpen(false);
                  } catch (error) {
                    toast.error(error instanceof Error ? error.message : 'It could not compact.');
                  } finally {
                    setCompacting(false);
                  }
                }}
              >
                Compact now
              </Action>
            )}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
