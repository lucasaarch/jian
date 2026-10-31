'use client';

import { RotateCcw, X } from 'lucide-react';
import { useState } from 'react';
import { Action, SettingsGroup, SettingsRow, TextField } from '../../kit';
import { bindingOf, isMac, shortcutOf } from '../commands/keybindings';
import { useKeymaps } from '../commands/registry';

/** The command registry owns execution; this page only records and edits its local bindings. */
export function KeymapsPage() {
  const keymaps = useKeymaps();
  const [search, setSearch] = useState('');
  const [recording, setRecording] = useState<string | null>(null);
  const [error, setError] = useState<{ id: string; message: string } | null>(null);
  if (!keymaps) return null;
  const shown = keymaps.commands.filter((command) =>
    [command.title, command.detail, ...(command.keywords ?? [])]
      .join(' ')
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  const report = (id: string, message: string | undefined) =>
    setError(message ? { id, message } : null);
  return (
    <>
      <div className="grid gap-3">
        <p className="text-[13px] text-muted">
          Shortcuts are kept on this computer. Select a shortcut and press {isMac() ? '⌘' : 'Ctrl'}{' '}
          with a key, optionally with Shift or Alt. Escape cancels; Backspace clears.
        </p>
        <TextField
          label="Find a command"
          placeholder="Search commands"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <Action
          className="w-fit"
          onClick={() => {
            keymaps.reset();
            setError(null);
            setRecording(null);
          }}
        >
          Restore defaults
        </Action>
      </div>
      <SettingsGroup title="Commands" note={`${shown.length} available`}>
        {shown.map((command) => (
          <SettingsRow
            key={command.id}
            title={command.title}
            description={command.detail}
            below={
              error?.id === command.id ? (
                <p role="alert" className="text-xs text-bad">
                  {error.message}
                </p>
              ) : undefined
            }
          >
            {command.keys && (
              <Action
                tone="quiet"
                size="small"
                className="rounded-full!"
                aria-label={`Clear shortcut for ${command.title}`}
                onClick={() => report(command.id, keymaps.setBinding(command.id, null))}
              >
                <X size={13} />
              </Action>
            )}
            {Object.hasOwn(keymaps.overrides, command.id) && (
              <Action
                tone="quiet"
                size="small"
                className="rounded-full!"
                aria-label={`Restore shortcut for ${command.title}`}
                onClick={() => report(command.id, keymaps.setBinding(command.id, undefined))}
              >
                <RotateCcw size={13} />
              </Action>
            )}
            <Action
              size="small"
              className="min-w-24 rounded-full!"
              aria-label={`Shortcut for ${command.title}`}
              aria-pressed={recording === command.id}
              onClick={() => {
                setRecording(command.id);
                setError(null);
              }}
              onBlur={() => setRecording(null)}
              onKeyDown={(event) => {
                if (recording !== command.id) return;
                if (event.key === 'Tab') {
                  setRecording(null);
                  return;
                }
                event.stopPropagation();
                event.preventDefault();
                if (event.key === 'Escape') {
                  setRecording(null);
                  return;
                }
                if (event.key === 'Backspace' || event.key === 'Delete') {
                  report(command.id, keymaps.setBinding(command.id, null));
                  setRecording(null);
                  return;
                }
                const keys = bindingOf(event.nativeEvent);
                if (!keys) return;
                const message = keymaps.setBinding(command.id, keys);
                report(command.id, message);
                if (!message) setRecording(null);
              }}
            >
              {recording === command.id
                ? 'Press shortcut…'
                : (shortcutOf(command.keys) ?? 'Unassigned')}
            </Action>
          </SettingsRow>
        ))}
        {shown.length === 0 && <p className="p-4 text-sm text-muted">No command matches.</p>}
      </SettingsGroup>
    </>
  );
}
