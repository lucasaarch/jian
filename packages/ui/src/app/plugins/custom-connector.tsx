'use client';

import { useRef, useState } from 'react';
import { useMcpServers } from '../../components/integrations/mcp-list';
import { Action, Overlay, OverlayActions } from '../../kit';
import { useActions } from '../../lib/workspace';
import { McpFields, useMcpDraft } from './mcp-fields';

/**
 * Adds a custom connector, an MCP server of the owner's: the one form of Plugins that is a
 * dialog, since there is no page yet for what does not exist. Saved, it goes to the end of the
 * list the gateway keeps, and `onAdded` is told its name, so its page can open.
 */
export function AddConnector({
  open,
  onOpenChange,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded: (name: string) => void;
}) {
  // Every opening starts empty, with nothing left of the one before.
  const [was, setWas] = useState(open);
  const [round, setRound] = useState(0);
  if (open !== was) {
    setWas(open);
    if (open) setRound(round + 1);
  }

  return (
    <Overlay open={open} onOpenChange={onOpenChange} title="Add an MCP server" size="form">
      <AddForm key={round} onCancel={() => onOpenChange(false)} onAdded={onAdded} />
    </Overlay>
  );
}

function AddForm({ onCancel, onAdded }: { onCancel: () => void; onAdded: (name: string) => void }) {
  const { api, mutate, busy } = useActions();
  const { save } = useMcpServers({ api, mutate });
  const fields = useMcpDraft(api);
  const form = useRef<HTMLFormElement>(null);
  const [failed, setFailed] = useState(false);

  return (
    <form
      ref={form}
      className="grid w-full gap-5 p-7"
      onSubmit={(event) => {
        event.preventDefault();
        const next = fields.made();
        void save(next, 'new').then((ok) => {
          setFailed(!ok);
          if (ok) onAdded(next.name);
        });
      }}
    >
      <header className="grid gap-1 pr-10">
        <h2 className="text-lg font-semibold tracking-tight">Add an MCP server</h2>
        <p className="text-sm text-muted">
          Every agent reaches it, and loads the tools it needs from it.
        </p>
      </header>
      <McpFields {...fields} busy={busy} />
      {failed && (
        <p role="alert" className="text-sm text-bad">
          Could not save. Check the fields, or refresh the page.
        </p>
      )}
      <OverlayActions>
        <Action
          tone="outline"
          busy={fields.testing}
          disabled={busy}
          onClick={() => {
            if (form.current?.reportValidity()) void fields.test();
          }}
        >
          Test
        </Action>
        <span className="flex-1" />
        <Action tone="quiet" onClick={onCancel}>
          Cancel
        </Action>
        <Action tone="primary" type="submit" busy={busy}>
          Add server
        </Action>
      </OverlayActions>
    </form>
  );
}
