'use client';

import { useState } from 'react';

/**
 * Copies to the clipboard and remembers what was copied for a moment, so its button can say so.
 * `id` tells the copied thing from the others on screen. The clipboard can be refused — no
 * permission, no secure context — and `failed` then names what could not be copied.
 */
export function useCopy() {
  const [copied, setCopied] = useState<string>();
  const [failed, setFailed] = useState<string>();

  const copy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      setFailed(id);
      return false;
    }
    setFailed(undefined);
    setCopied(id);
    // 1.5 s; a later copy is not cut short by an earlier one's timer.
    window.setTimeout(() => setCopied((current) => (current === id ? undefined : current)), 1500);
    return true;
  };

  return { copied, failed, copy };
}
