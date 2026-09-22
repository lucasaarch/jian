'use client';

import { CheckCircle2, ChevronDown, Plug, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import type { GatewayApi, McpStatus, Profile } from '../../lib/api';

/** Collapsed, the list says what the server offers without burying the row under it. */
const PREVIEW = 12;

export function useMcpCheck(profile: Profile, name: string, api: GatewayApi) {
  const [status, setStatus] = useState<McpStatus>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  return {
    status,
    error,
    busy,
    check: async () => {
      setBusy(true);
      setError('');

      try {
        setStatus(await api.checkMcpServer(profile.id, name));
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : 'The check could not run.');
      } finally {
        setBusy(false);
      }
    },
  };
}

/** What the last check answered. Absent until the owner asks, so the row stays a row. */
export function McpResult({ status, error }: { status?: McpStatus; error: string }) {
  const [open, setOpen] = useState(false);

  if (error) {
    return (
      <p className="form-error mt-2" role="alert">
        {error}
      </p>
    );
  }

  if (!status) {
    return null;
  }

  if (!status.reachable) {
    return (
      <p className="mcp-state bad" role="alert">
        <TriangleAlert size={14} />
        <span>Did not connect — {status.error}</span>
      </p>
    );
  }

  const shown = open ? status.tools : status.tools.slice(0, PREVIEW);
  const rest = status.tools.length - shown.length;

  return (
    <div className="mt-2" role="status">
      <p className="mcp-state good">
        <CheckCircle2 size={14} />
        <span>
          Connected — {status.tools.length} {status.tools.length === 1 ? 'tool' : 'tools'}
        </span>
      </p>
      {status.tools.length > 0 && (
        <>
          <div className={`mcp-tools ${open ? 'open' : ''}`}>
            {shown.map((tool) => (
              <code key={tool.name} title={tool.description}>
                {tool.name}
              </code>
            ))}
          </div>
          {(rest > 0 || open) && (
            <button
              type="button"
              className="text-button mt-2"
              aria-expanded={open}
              onClick={() => setOpen(!open)}
            >
              <ChevronDown size={14} className={open ? 'rotate-180' : ''} />
              {open ? 'Show fewer' : `See the other ${rest}`}
            </button>
          )}
        </>
      )}
    </div>
  );
}

/** The action itself, so it sits with edit and remove instead of inside the description. */
export function McpCheckButton({
  name,
  busy,
  onCheck,
}: {
  name: string;
  busy: boolean;
  onCheck: () => void;
}) {
  return (
    <button
      type="button"
      className="icon-button"
      aria-label={`Test the connection to ${name}`}
      title="Test the connection"
      disabled={busy}
      onClick={onCheck}
    >
      <Plug size={16} className={busy ? 'spin' : ''} />
    </button>
  );
}
