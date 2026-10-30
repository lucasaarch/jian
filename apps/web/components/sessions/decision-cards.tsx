'use client';

import { Check, ChevronRight } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { highlightLines } from '@/components/ui/highlight';
import type { RunApproval, RunQuestion } from '@/lib/api';
import { Button } from '../ui';

function Card({
  chip,
  tone = 'neutral',
  title,
  children,
  footer,
}: {
  chip: string;
  tone?: 'neutral' | 'good' | 'bad';
  title: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <section className="decision-card" aria-label={chip}>
      {/* The state sits in the corner, so what is asked opens the card. */}
      <header className="decision-head">
        <p className="decision-title">{title}</p>
        <span className="decision-chip" data-tone={tone}>
          {chip}
        </span>
      </header>
      {children && <div className="decision-body">{children}</div>}
      {footer && <div className="decision-footer">{footer}</div>}
    </section>
  );
}

/** The call as the agent asked for it, folded until the reader wants to see it. */
function Request({ json }: { json: string }) {
  const [open, setOpen] = useState(false);
  const pretty = (() => {
    try {
      return JSON.stringify(JSON.parse(json), null, 2);
    } catch {
      // Cut to its limit by the gateway, the text may no longer parse; it still reads.
      return json;
    }
  })();

  return (
    <div className="decision-request" data-open={open || undefined}>
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <ChevronRight size={14} aria-hidden="true" />
        {open ? 'Hide request' : 'Show request'}
      </button>
      {open && (
        <pre>
          <code>
            {highlightLines(pretty, 'json').map((line, row) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: lines are positions, never reordered.
              <span key={row}>
                {line.map((segment, index) =>
                  segment.className ? (
                    // biome-ignore lint/suspicious/noArrayIndexKey: segments are positions too.
                    <span key={index} className={segment.className}>
                      {segment.text}
                    </span>
                  ) : (
                    segment.text
                  ),
                )}
                {'\n'}
              </span>
            ))}
          </code>
        </pre>
      )}
    </div>
  );
}

/**
 * An action the agent asked to take, in the conversation where it asked. Pending, the owner
 * decides it here, unless the conversation is a channel's chat, where only a contact allowed
 * to approve decides it, in the chat; then this card only says what is waiting. Decided, it
 * says how and by whom.
 */
export function ApprovalCard({
  approval,
  chat,
  busy = false,
  onDecide,
}: {
  approval: RunApproval;
  /** The channel a chat's approval is decided in, by name: no buttons here. */
  chat?: string;
  busy?: boolean;
  onDecide?: (decision: 'approve' | 'reject') => void;
}) {
  const decided = approval.decision;
  // Only who else decided is worth a line: a decision with no line was the owner's own.
  const where = approval.decidedBy === 'contact' && chat ? ` in ${chat}` : '';

  const chip = !decided ? 'Needs approval' : decided === 'approved' ? 'Approved' : 'Rejected';
  const tone = !decided ? 'neutral' : decided === 'approved' ? 'good' : 'bad';

  return (
    <Card
      chip={chip}
      tone={tone}
      title={approval.title}
      footer={
        !decided && !chat && onDecide ? (
          <>
            <Button variant="secondary" disabled={busy} onClick={() => onDecide('reject')}>
              Reject
            </Button>
            <Button disabled={busy} onClick={() => onDecide('approve')}>
              {approval.confirmLabel}
            </Button>
          </>
        ) : undefined
      }
    >
      <Request json={approval.request} />
      {!decided && chat && <p className="decision-state">Waiting for an answer in {chat}.</p>}
      {decided && (where || approval.note) && (
        <p className="decision-state">
          {where && `${decided === 'approved' ? 'Approved' : 'Declined'}${where}`}
          {where && approval.note && ': '}
          {approval.note}
        </p>
      )}
    </Card>
  );
}

/**
 * A question the agent asked, as a list of its choices, the one it recommends marked. Pending,
 * a choice answers it here, except in a channel's chat, where the person answers in the chat
 * and this card only shows what was asked. Answered, it stays: the chosen row is checked and
 * the rest step back, or the answer is quoted when it was written rather than picked.
 */
export function QuestionCard({
  question,
  chat,
  busy = false,
  onAnswer,
}: {
  question: RunQuestion;
  chat?: string;
  busy?: boolean;
  onAnswer?: (choice: string) => void;
}) {
  const choices = question.choices ?? [];
  const answered = question.answer !== undefined;
  const picked = answered ? choices.find((choice) => choice === question.answer) : undefined;
  const answering = !answered && !chat && Boolean(onAnswer);
  // As on an approval: only an answer given elsewhere says where it came from.
  const where = question.answeredBy === 'contact' && chat ? ` in ${chat}` : '';

  return (
    <Card chip="Question" tone={answered ? 'good' : 'neutral'} title={question.prompt}>
      {choices.length > 0 && (
        <ul className="decision-options" aria-label="Choices">
          {choices.map((choice) => {
            const chosen = choice === picked;
            const content = (
              <>
                <span className="decision-mark" aria-hidden="true">
                  {chosen && <Check size={12} strokeWidth={3} />}
                </span>
                <span className="decision-option-text">{choice}</span>
                {choice === question.recommended && (
                  <span className="decision-recommended">Recommended</span>
                )}
              </>
            );

            return (
              <li key={choice}>
                {answering ? (
                  <button
                    type="button"
                    className="decision-option"
                    disabled={busy}
                    onClick={() => onAnswer?.(choice)}
                  >
                    {content}
                  </button>
                ) : (
                  <div
                    className="decision-option"
                    data-chosen={chosen || undefined}
                    data-muted={(answered && !chosen) || undefined}
                    aria-current={chosen || undefined}
                  >
                    {content}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {answered && !picked && (
        <p className="decision-answer">
          {where && <span>Answered{where}</span>}
          {question.answer}
        </p>
      )}
      {answered && picked && where && <p className="decision-state">Answered{where}.</p>}
      {!answered && chat && <p className="decision-state">Waiting for an answer in {chat}.</p>}
      {!answered && !chat && !choices.length && (
        <p className="decision-state">Answer below to continue.</p>
      )}
    </Card>
  );
}
