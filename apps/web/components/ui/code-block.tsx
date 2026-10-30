'use client';

import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { highlightLines } from './highlight';

/**
 * A fenced block of code in a message, read as an editor shows it: its language and a copy
 * button above, the lines numbered and coloured. The numbers are drawn, not text, so copying
 * by hand takes only the code.
 */
export function CodeBlock({ text, language }: { text: string; language?: string }) {
  const [copied, setCopied] = useState(false);
  const lines = highlightLines(text, language);

  return (
    <figure className="code-block">
      <figcaption className="code-block-head">
        <span>{language || 'Code'}</span>
        <button
          type="button"
          aria-label={copied ? 'Copied' : 'Copy the code'}
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(text);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            } catch {
              // Refused by the browser: the code stays selectable.
            }
          }}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </figcaption>
      <div className="code-block-body">
        <pre className="code-block-lines">
          <code>
            {lines.map((line, row) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: lines are positions, never reordered.
              <span key={row} className="code-block-line" data-line={row + 1}>
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
      </div>
    </figure>
  );
}
