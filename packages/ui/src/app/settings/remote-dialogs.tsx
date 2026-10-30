'use client';

import { type FormEvent, type ReactNode, useRef, useState } from 'react';
import type { Machine, Reveal } from '../../components/remote/machines';
import { Action, Overlay, TextField } from '../../kit';
import { CopyCommand } from './copy-command';

/** The top of a dialog of these pages: what it is, and what it does. */
function DialogHeader({ title, children }: { title: string; children: ReactNode }) {
  return (
    <header className="grid gap-1 pr-6">
      <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
      <p className="text-sm text-muted">{children}</p>
    </header>
  );
}

/** Names a computer to register; its install command follows once it exists. */
export function AddMachine({
  open,
  onOpenChange,
  create,
  busy,
  error,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Whether the machine was registered. */
  create: (name: string) => Promise<boolean>;
  busy: boolean;
  error: string;
}) {
  const [name, setName] = useState('');
  // The error is the last action's on the machines; it is this form's only after a submit here.
  const [submitted, setSubmitted] = useState(false);
  const close = () => {
    setSubmitted(false);
    onOpenChange(false);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitted(true);
    if (await create(name)) {
      setName('');
      close();
    }
  };

  return (
    <Overlay
      open={open}
      onOpenChange={(next) => (next ? onOpenChange(true) : close())}
      title="Add a machine"
      size="form"
    >
      <form onSubmit={submit} className="grid w-full gap-5 p-7">
        <DialogHeader title="Add a machine">
          Name the computer. Every agent can use it once it connects.
        </DialogHeader>
        <TextField
          label="Machine name"
          hint="A label you will recognize, such as the owner and the OS."
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Maya's Windows PC"
          required
          maxLength={80}
          autoComplete="off"
        />
        {submitted && error && (
          <p role="alert" className="text-sm text-bad">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Action tone="quiet" onClick={close}>
            Cancel
          </Action>
          <Action tone="primary" type="submit" busy={busy} disabled={!name.trim()}>
            Create machine
          </Action>
        </div>
      </form>
    </Overlay>
  );
}

/**
 * The install command with a new worker token, shown this once. It keeps what it showed while
 * it fades out, after the token itself is forgotten.
 */
export function RevealCommand({
  reveal,
  command,
  onClose,
}: {
  reveal: Reveal | null;
  command: string;
  onClose: () => void;
}) {
  const shown = useRef({ reveal, command });
  if (reveal) shown.current = { reveal, command };
  const last = shown.current.reveal;
  const rotated = last?.kind === 'rotated';
  const title = rotated ? `Credentials rotated for ${last?.name}` : `${last?.name ?? ''} created`;

  return (
    <Overlay
      open={reveal !== null}
      onOpenChange={(open) => !open && onClose()}
      title={title}
      size="form"
    >
      <div className="grid w-full gap-5 p-7">
        <DialogHeader title={title}>
          {rotated
            ? 'The previous worker token no longer works. Run this on the computer to connect it again; the command is shown only once.'
            : 'Run this on the computer. It installs jian-remote and connects it; the command is shown only once.'}
        </DialogHeader>
        <CopyCommand value={shown.current.command} label="Copy command" />
        <p className="text-xs leading-relaxed text-muted">
          Needs Node.js 24+ on the computer and HTTPS access to this gateway. The command includes
          the worker token; clear shell history if you share that terminal. The worker starts again
          on login; update it here, or ask an agent to. On the computer,{' '}
          <code className="font-mono text-ink">jian-remote status</code> says how it stands and{' '}
          <code className="font-mono text-ink">jian-remote logs</code> what it did.
        </p>
        <div className="flex justify-end">
          <Action tone="primary" onClick={onClose}>
            Done
          </Action>
        </div>
      </div>
    </Overlay>
  );
}

/**
 * Asks before a machine's worker token is replaced. Nothing is lost — the machine stays
 * registered and its command comes back with the new token — so its name is not asked for.
 */
export function RotateCredentials({
  machine,
  open,
  onOpenChange,
  rotate,
  busy,
}: {
  machine: Machine | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rotate: () => void;
  busy: boolean;
}) {
  const title = `Rotate credentials for ${machine?.name ?? ''}?`;

  return (
    <Overlay open={open} onOpenChange={onOpenChange} title={title} size="form">
      <div className="grid w-full gap-5 p-7">
        <DialogHeader title={title}>
          Issues a new worker token and invalidates the current one. The machine stays registered;
          you get its install command again, with the new token, to run on that computer.
        </DialogHeader>
        <div className="flex justify-end gap-2">
          <Action tone="quiet" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Action>
          <Action tone="primary" busy={busy} onClick={rotate}>
            Rotate credentials
          </Action>
        </div>
      </div>
    </Overlay>
  );
}
