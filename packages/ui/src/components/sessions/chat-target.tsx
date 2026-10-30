import type { ReactNode } from 'react';

/**
 * Where a chat that began works — its project, its machine — said beside the composer as the
 * choosers before its first message said it, but as words: it is set for the whole chat.
 */
export function ChatTarget({ icon, label }: { icon: ReactNode; label: string }) {
  return (
    <span
      className="inline-flex h-8 max-w-48 items-center gap-1.5 px-2.5 text-xs text-muted"
      title="Set when the chat began"
    >
      <span className="shrink-0" aria-hidden="true">
        {icon}
      </span>
      <span className="truncate">{label}</span>
    </span>
  );
}
