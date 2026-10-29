'use client';

import { ChevronRight } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import type { RunApproval } from '@/lib/api';
import { Button } from '../ui';

/** The question a waiting run asks, as the timeline carries it. */
type Question = { prompt: string; choices?: string[] };

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
      <span className="decision-chip" data-tone={tone}>
        {chip}
      </span>
      <p className="decision-title">{title}</p>
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
      {open && <pre>{pretty}</pre>}
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
  const where = approval.decidedBy === 'contact' && chat ? ` in ${chat}` : '';
  const by = approval.decidedBy === 'owner' ? ' by you' : where;

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
      {approval.detail && <p>{approval.detail}</p>}
      <Request json={approval.request} />
      {!decided && chat && <p className="decision-state">Waiting for an answer in {chat}.</p>}
      {decided && (
        <p className="decision-state">
          {decided === 'approved' ? `Approved${by}.` : `Declined${by}`}
          {decided === 'rejected' && (approval.note ? `: ${approval.note}` : '.')}
        </p>
      )}
    </Card>
  );
}

/**
 * A question the agent is waiting on. Its choices answer it here, except in a channel's chat,
 * where the person answers in the chat and this card only shows what was asked.
 */
export function QuestionCard({
  question,
  chat,
  busy = false,
  onAnswer,
}: {
  question: Question;
  chat?: string;
  busy?: boolean;
  onAnswer?: (choice: string) => void;
}) {
  const choices = question.choices ?? [];

  return (
    <Card
      chip="Question"
      title={question.prompt}
      footer={
        choices.length > 0 && !chat && onAnswer
          ? choices.map((choice) => (
              <Button
                key={choice}
                variant="secondary"
                disabled={busy}
                onClick={() => onAnswer(choice)}
              >
                {choice}
              </Button>
            ))
          : undefined
      }
    >
      {chat ? (
        <>
          {choices.length > 0 && (
            <ol className="decision-choices">
              {choices.map((choice) => (
                <li key={choice}>{choice}</li>
              ))}
            </ol>
          )}
          <p className="decision-state">Waiting for an answer in {chat}.</p>
        </>
      ) : (
        !choices.length && <p className="decision-state">Answer below to continue.</p>
      )}
    </Card>
  );
}
