'use client';

import { Check, Copy, Plus, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { useSshKeys } from '../../components/ssh-keys/keys';
import {
  Action,
  ConfirmDialog,
  Overlay,
  SettingsGroup,
  SettingsRow,
  StatusPill,
  TextField,
} from '../../kit';
import type { SshKey } from '../../lib/api';
import { useCopy } from '../../lib/copy';
import { date } from '../../lib/format';
import { useActions } from '../../lib/workspace';
import { CopyCommand } from './copy-command';

/**
 * The gateway's SSH keys, which every agent uses for Git and SSH: each a line whose public part
 * is copied with one press — nobody reads a key, it is only ever pasted elsewhere — one more to
 * create, and one to delete after its name is typed.
 */
export function SshKeysPage() {
  const { api, mutate, busy } = useActions();
  const { keys, loading, error, create, remove } = useSshKeys({ api, mutate });
  const [creating, setCreating] = useState(false);
  // The key asked about stays named while its dialog fades out.
  const [removing, setRemoving] = useState<SshKey>();
  const [asking, setAsking] = useState(false);
  const { copied, failed, copy } = useCopy();

  const note = error ? (
    <span role="alert" className="text-bad">
      {error}
    </span>
  ) : loading ? (
    'Loading…'
  ) : keys.length === 0 ? (
    'None yet'
  ) : undefined;

  return (
    <>
      <SettingsGroup title="Keys" note={note}>
        {keys.map((key) => (
          <SettingsRow
            key={key.id}
            title={
              <span className="flex items-center gap-2">
                <span className="truncate">{key.name}</span>
                <StatusPill>Ed25519</StatusPill>
              </span>
            }
            description={
              failed === key.id ? (
                <span role="alert" className="text-bad">
                  The clipboard was refused; copy it from the gateway's web panel.
                </span>
              ) : (
                `Created ${date(key.createdAt)}`
              )
            }
          >
            <Action
              tone="outline"
              size="small"
              aria-label={`Copy the public key of ${key.name}`}
              onClick={() => void copy(key.id, key.publicKey)}
            >
              {copied === key.id ? <Check size={13} /> : <Copy size={13} />}
              {copied === key.id ? 'Copied' : 'Copy'}
            </Action>
            <Action
              tone="danger"
              size="small"
              className="border border-bad/40"
              aria-label={`Delete ${key.name}`}
              disabled={busy}
              onClick={() => {
                setRemoving(key);
                setAsking(true);
              }}
            >
              <Trash2 size={13} />
              Delete
            </Action>
          </SettingsRow>
        ))}
        <SettingsRow title="Create SSH key">
          <Action tone="outline" size="small" onClick={() => setCreating(true)}>
            <Plus size={13} />
            Create
          </Action>
        </SettingsRow>
      </SettingsGroup>
      <NewKey open={creating} onOpenChange={setCreating} create={create} busy={busy} />
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title={`Delete ${removing?.name ?? ''}?`}
        phrase={removing?.name ?? ''}
        action="Delete key"
        busy={busy}
        run={async () => {
          if (removing && (await remove(removing))) setAsking(false);
        }}
      >
        Its private part is gone for every agent, and whatever trusts the key stops letting them in.
        This cannot be undone.
      </ConfirmDialog>
    </>
  );
}

/** Names a new key, then shows its public part once it exists, to be added where it is needed. */
function NewKey({
  open,
  onOpenChange,
  create,
  busy,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  create: (name: string) => Promise<SshKey | undefined>;
  busy: boolean;
}) {
  const [name, setName] = useState('');
  const [created, setCreated] = useState<SshKey>();

  // Closing forgets the key just shown, so the next opening asks for a name again.
  const close = (next: boolean) => {
    onOpenChange(next);
    if (!next) setCreated(undefined);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const key = await create(name);
    if (key) {
      setName('');
      setCreated(key);
    }
  };

  const title = created ? `${created.name} created` : 'Create SSH key';

  return (
    <Overlay open={open} onOpenChange={close} title={title} size="form">
      {created ? (
        <PublicKey title={title} sshKey={created} done={() => close(false)} />
      ) : (
        <form onSubmit={submit} className="grid w-full gap-5 p-7">
          <header className="grid gap-1 pr-6">
            <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
            <p className="text-sm text-muted">
              The gateway makes an Ed25519 key and keeps its private part encrypted.
            </p>
          </header>
          <TextField
            label="Key name"
            hint="A label that tells you where this key is used."
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="GitHub"
            required
            autoComplete="off"
          />
          <div className="flex justify-end gap-2">
            <Action tone="quiet" onClick={() => close(false)}>
              Cancel
            </Action>
            <Action tone="primary" type="submit" busy={busy} disabled={!name.trim()}>
              Create key
            </Action>
          </div>
        </form>
      )}
    </Overlay>
  );
}

/** A key's public part, to read and copy into what should trust the agents. */
function PublicKey({ title, sshKey, done }: { title: string; sshKey: SshKey; done: () => void }) {
  return (
    <div className="grid w-full gap-5 p-7">
      <header className="grid gap-1 pr-6">
        <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
        <p className="text-sm text-muted">
          Add this public key to the Git or SSH service that should trust your agents.
        </p>
      </header>
      <CopyCommand value={sshKey.publicKey} label="Copy public key" />
      <p className="font-mono text-xs text-muted">{sshKey.fingerprint}</p>
      <div className="flex justify-end">
        <Action tone="primary" onClick={done}>
          Done
        </Action>
      </div>
    </div>
  );
}
