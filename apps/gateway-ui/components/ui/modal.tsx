'use client';

import { X } from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef } from 'react';
import { Button } from './button';

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
}: {
  title: string;
  description: string;
  confirm: () => void;
  close: () => void;
  busy?: boolean;
}) {
  return (
    <Modal title={title} description={description} close={close}>
      <footer>
        <Button variant="secondary" onClick={close}>
          Cancel
        </Button>
        <Button variant="danger" busy={busy} onClick={confirm}>
          Confirm
        </Button>
      </footer>
    </Modal>
  );
}
