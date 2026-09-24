'use client';

import { Check, CheckCircle2, ChevronDown, EyeOff, LogIn, TriangleAlert } from 'lucide-react';
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
export function McpResult({
  status,
  error,
  disabled = [],
  onToggle,
  busy = false,
}: {
  status?: McpStatus;
  error: string;
  /** The tools switched off for the agent, by the server's own names. */
  disabled?: string[];
  /** Present when a tool can be switched here; each tool is then a button. */
  onToggle?: (tool: string) => void;
  busy?: boolean;
}) {
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
      <div className="mt-2" role="alert">
        <p className="mcp-state bad">
          <TriangleAlert size={14} />
          <span>Did not connect — {status.error}</span>
        </p>
        {status.authorizationUrl && (
          <a
            className="text-button mt-1"
            href={status.authorizationUrl}
            target="_blank"
            rel="noreferrer"
          >
            <LogIn size={14} />
            Sign in to this server
          </a>
        )}
      </div>
    );
  }

  const shown = open ? status.tools : status.tools.slice(0, PREVIEW);
  const off = status.tools.filter((tool) => disabled.includes(tool.name)).length;
  const rest = status.tools.length - shown.length;

  return (
    <div className="mt-2" role="status">
      <p className="mcp-state good">
        <CheckCircle2 size={14} />
        <span>
          Connected — {status.tools.length} {status.tools.length === 1 ? 'tool' : 'tools'}
          {off > 0 && `, ${off} switched off`}
        </span>
      </p>
      {onToggle && status.tools.length > 0 && (
        <p className="mcp-hint">Click a tool to switch it off for the agent, or on again.</p>
      )}
      {status.tools.length > 0 && (
        <>
          <div className={`mcp-tools ${open ? 'open' : ''}`}>
            {shown.map((tool) =>
              onToggle ? (
                <button
                  type="button"
                  key={tool.name}
                  className="mcp-tool"
                  title={tool.description}
                  aria-pressed={!disabled.includes(tool.name)}
                  disabled={busy}
                  onClick={() => onToggle(tool.name)}
                >
                  {disabled.includes(tool.name) ? <EyeOff size={12} /> : <Check size={12} />}
                  {tool.name}
                </button>
              ) : (
                <code key={tool.name} title={tool.description}>
                  {tool.name}
                </code>
              ),
            )}
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
