'use client';

import { Menu } from '@base-ui/react/menu';
import { Check, ChevronDown, GitMerge } from 'lucide-react';
import { useState } from 'react';
import { Action, Overlay } from '../../../kit';
import { MenuEntry, menuPopup } from '../../../kit/menu';
import type { GitHubMergeMethod, GitHubPull } from '../../../lib/api';

const methodNames: Record<GitHubMergeMethod, { action: string; detail: string }> = {
  merge: { action: 'Merge', detail: 'with a merge commit' },
  squash: { action: 'Squash and merge', detail: 'as one squashed commit' },
  rebase: { action: 'Rebase and merge', detail: 'with its commits rebased onto it' },
};

/**
 * Merging, as GitHub offers it: the method the repository prefers, squash when it allows it, and
 * the others a menu away. A draft, a branch in conflict or a repository that allows none cannot.
 */
export function MergeButton({
  pull,
  merge,
}: {
  pull: GitHubPull;
  merge: (method: GitHubMergeMethod) => void;
}) {
  const [method, setMethod] = useState<GitHubMergeMethod>(
    pull.mergeMethods.includes('squash') ? 'squash' : (pull.mergeMethods[0] ?? 'merge'),
  );
  const blocked = pull.draft || pull.mergeable === 'conflicts' || !pull.mergeMethods.length;

  return (
    <div className="inline-flex">
      <Action
        tone="primary"
        size="small"
        className={pull.mergeMethods.length > 1 ? 'rounded-r-none' : ''}
        disabled={blocked}
        onClick={() => merge(method)}
      >
        <GitMerge size={13} aria-hidden="true" />
        {methodNames[method].action}
      </Action>
      {pull.mergeMethods.length > 1 && (
        <Menu.Root>
          <Menu.Trigger
            aria-label="Merge method"
            disabled={blocked}
            className="grid h-7 w-7 place-items-center rounded-r-md border-l border-on-accent/25 bg-accent text-on-accent transition-colors hover:bg-accent-hover disabled:pointer-events-none disabled:opacity-45"
          >
            <ChevronDown size={13} aria-hidden="true" />
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Positioner side="bottom" align="end" sideOffset={6} className="z-50">
              <Menu.Popup className={menuPopup}>
                {pull.mergeMethods.map((item) => (
                  <MenuEntry
                    key={item}
                    icon={item === method ? <Check size={14} /> : <span />}
                    onClick={() => setMethod(item)}
                  >
                    {methodNames[item].action}
                  </MenuEntry>
                ))}
              </Menu.Popup>
            </Menu.Positioner>
          </Menu.Portal>
        </Menu.Root>
      )}
    </div>
  );
}

/** Merging asked once more, saying what lands where and how: GitHub does not take it back. */
export function MergeConfirm({
  pull,
  method,
  busy,
  close,
  merge,
}: {
  pull: GitHubPull;
  method: GitHubMergeMethod | undefined;
  busy: boolean;
  close: () => void;
  merge: (method: GitHubMergeMethod) => void;
}) {
  const shown = method ?? 'merge';

  return (
    <Overlay
      open={Boolean(method)}
      onOpenChange={(open) => !open && close()}
      title={`${methodNames[shown].action} #${pull.number}?`}
      size="form"
    >
      <div className="grid w-full gap-5 p-7">
        <header className="grid gap-1.5 pr-6">
          <h2 className="text-lg font-semibold tracking-tight">
            {methodNames[shown].action} #{pull.number}?
          </h2>
          <p className="text-sm leading-relaxed text-muted">
            {pull.head.ref} lands on {pull.base.ref} {methodNames[shown].detail}.
          </p>
        </header>
        <div className="flex items-center justify-end gap-2">
          <Action tone="quiet" disabled={busy} onClick={close}>
            Cancel
          </Action>
          <Action tone="primary" busy={busy} onClick={() => method && merge(method)}>
            {methodNames[shown].action}
          </Action>
        </div>
      </div>
    </Overlay>
  );
}
