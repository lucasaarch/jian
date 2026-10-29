'use client';

import { Check, Copy, ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { Button, buttonClass, IconButton, Modal, Spinner } from '../ui';

/**
 * Starts the ChatGPT sign-in from the owner's click: the code goes to the clipboard and the
 * OpenAI page opens in a new tab. Copying needs this page focused, so it runs before the tab
 * takes the focus away. Either can be refused — a browser without clipboard access, a popup
 * blocker — which is why the dialog still shows both.
 */
export async function handOff(login: { verificationUrl?: string; userCode?: string }) {
  const copied = login.userCode
    ? await navigator.clipboard.writeText(login.userCode).then(
        () => true,
        () => false,
      )
    : false;

  if (login.verificationUrl) window.open(login.verificationUrl, '_blank', 'noopener,noreferrer');

  return copied;
}

/** The code the owner types on the OpenAI page, while the gateway waits for them to. */
export function CodexCode({
  verificationUrl,
  userCode,
  copied: copiedAtStart,
  close,
}: {
  verificationUrl: string;
  userCode: string;
  copied: boolean;
  close: () => void;
}) {
  const [copied, setCopied] = useState(copiedAtStart);
  const [error, setError] = useState('');

  return (
    <Modal
      title="Sign in with ChatGPT"
      description="Enter this code on the OpenAI page. This closes once ChatGPT connects."
      close={close}
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <a
            className={buttonClass('primary')}
            href={verificationUrl}
            target="_blank"
            rel="noreferrer"
          >
            <ExternalLink size={16} />
            Open the OpenAI login
          </a>
        </>
      }
    >
      <div className="device-code">
        <output aria-label="Login code">{userCode}</output>
        <IconButton
          aria-label="Copy the code"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(userCode);
              setCopied(true);
              setError('');
            } catch {
              setError('Select the code and copy it by hand.');
            }
          }}
        >
          {copied ? <Check size={18} /> : <Copy size={18} />}
        </IconButton>
      </div>
      <p className="device-code-state" role="status">
        <Spinner size={14} />
        {copied ? 'Copied to the clipboard. Waiting for the sign-in…' : 'Waiting for the sign-in…'}
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}
