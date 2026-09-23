'use client';

import { X } from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { Button } from './button';
import { Field } from './field';

/** A native dialog: Escape and the backdrop are the browser's, so close() is the only exit. */
export function Modal({
  title,
  description,
  children,
  close,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  close: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const heading = useId();

  useEffect(() => {
    ref.current?.showModal();

    return () => ref.current?.close();
  }, []);

  return (
    <dialog
      ref={ref}
      className="modal"
      aria-labelledby={heading}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <header>
        <div>
          <h2 id={heading}>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        <button className="icon-button" type="button" aria-label="Close" onClick={close}>
          <X size={20} />
        </button>
      </header>
      {children}
    </dialog>
  );
}

export function Confirm({
  title,
  description,
  confirm,
  close,
  busy,
  phrase,
}: {
  title: string;
  description: string;
  confirm: () => void;
  close: () => void;
  busy?: boolean;
  /** For what cannot be undone: confirming waits until this is typed exactly. */
  phrase?: string;
}) {
  const [typed, setTyped] = useState('');
  const matches = !phrase || typed.trim() === phrase;

  return (
    <Modal title={title} description={description} close={close}>
      {phrase && (
        <Field label={`Type ${phrase} to confirm`}>
          <input
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            // biome-ignore lint/a11y/noAutofocus: the dialog exists to take this one answer.
            autoFocus
          />
        </Field>
      )}
      <footer>
        <Button variant="secondary" onClick={close}>
          Cancel
        </Button>
        <Button variant="danger" busy={busy} disabled={!matches} onClick={confirm}>
          Confirm
        </Button>
      </footer>
    </Modal>
  );
}
