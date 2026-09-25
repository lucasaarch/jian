'use client';

import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { Button } from './button';
import { Modal } from './modal';

/** A value the gateway shows once. Copying can be refused, so the text stays selectable. */
export function Secret({
  title,
  value,
  close,
}: {
  title: string;
  value: string;
  close: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');

  return (
    <Modal
      title={title}
      description="Save this value now. It cannot be read again."
      close={close}
      footer={
        <>
          <Button
            variant="secondary"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(value);
                setCopied(true);
              } catch {
                setError('Select the value above and copy it by hand.');
              }
            }}
          >
            {copied ? <Check size={16} /> : <Copy size={16} />}
            {copied ? 'Copied' : 'Copy'}
          </Button>
          <Button onClick={close}>I saved it</Button>
        </>
      }
    >
      <textarea
        className="secret-value"
        aria-label="Valor gerado"
        value={value}
        readOnly
        rows={4}
        spellCheck={false}
      />
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}
