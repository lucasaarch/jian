'use client';

import { Plus, Save, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { GatewayApi, Mutation, Profile } from '../../lib/api';
import { useWorkspace } from '../../lib/workspace';
import { Button, Confirm, Field, Modal, SectionHeading } from '../ui';
import { AvatarField } from './avatar-field';

const lines = (value: string) =>
  value
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean);

export function NewProfileDialog({
  api,
  done,
  close,
}: {
  api: GatewayApi;
  done: (profile: Profile) => void;
  close: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  return (
    <Modal title="A new profile" description="One identity for every conversation." close={close}>
      <form
        method="post"
        action="/ui/"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError('');

          const form = new FormData(event.currentTarget);

          try {
            done(
              await api.createProfile({
                name: String(form.get('name')),
                instructions: String(form.get('instructions')),
                avatar: String(form.get('avatar')) || null,
              }),
            );
          } catch (error) {
            setError(error instanceof Error ? error.message : 'The profile could not be created.');
          } finally {
            setBusy(false);
          }
        }}
      >
        <AvatarField name="avatar" />
        <Field label="Name">
          <input name="name" required maxLength={100} placeholder="e.g. Personal assistant" />
        </Field>
        <Field
          label="Instructions"
          hint="Say what it is for, how it should sound and what it aims at."
        >
          <textarea
            name="instructions"
            rows={5}
            required
            maxLength={8000}
            placeholder="Help me organise my tasks and keep track of decisions."
          />
        </Field>
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        <footer>
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" busy={busy}>
            <Plus size={16} />
            Create profile
          </Button>
        </footer>
      </form>
    </Modal>
  );
}

export function ProfileEditor({
  profile,
  api,
  mutate,
  busy,
}: {
  profile: Profile;
  api: GatewayApi;
  mutate: Mutation;
  busy: boolean;
}) {
  const { deleteProfile } = useWorkspace();
  const [deleting, setDeleting] = useState(false);

  const legacyIdentity = [
    profile.identity.role && `Role: ${profile.identity.role}`,
    profile.identity.tone && `Tone: ${profile.identity.tone}`,
    ...profile.identity.goals.map((goal) => `Goal: ${goal}`),
  ].filter(Boolean);
  const instructions = [profile.instructions, ...legacyIdentity].join('\n\n');

  return (
    <>
      <SectionHeading
        title="Identity"
        description="Instructions shared by every session of this profile."
      />
      <form
        className="profile-form"
        method="post"
        action="/ui/"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);

          void mutate(
            () =>
              api.updateProfile(profile.id, {
                expectedVersion: profile.version,
                name: String(form.get('name')),
                instructions: String(form.get('instructions')),
                summary: String(form.get('summary')),
                avatar: String(form.get('avatar')) || null,
                identity: {
                  role: '',
                  tone: '',
                  goals: [],
                  boundaries: lines(String(form.get('boundaries'))),
                },
                allowSelfManagement: form.get('selfManagement') === 'on',
                allowShell: form.get('shell') === 'on',
                allowWebSearch: form.get('webSearch') === 'on',
              }),
            'Profile updated.',
          );
        }}
      >
        <div className="identity-form">
          <div className="settings-fields">
            <AvatarField name="avatar" profileName={profile.name} current={profile.avatar} />
            <Field label="Name">
              <input name="name" defaultValue={profile.name} required maxLength={100} />
            </Field>
            <Field label="Instructions">
              <textarea
                name="instructions"
                defaultValue={instructions}
                rows={8}
                required
                maxLength={8000}
              />
            </Field>
            <Field
              label="Summary for the team"
              hint="One line on what this agent does. It is all the other profiles ever see of it."
            >
              <input
                name="summary"
                defaultValue={profile.summary}
                maxLength={280}
                placeholder="e.g. Looks after deliveries and knows where each one stands."
              />
            </Field>
            <Field label="Boundaries" hint="Rules this profile must respect, one per line.">
              <textarea
                name="boundaries"
                defaultValue={profile.identity.boundaries.join('\n')}
                rows={3}
              />
            </Field>
            <label className="check-row">
              <input
                name="selfManagement"
                type="checkbox"
                defaultChecked={profile.allowSelfManagement}
              />
              <span>
                <strong>Allow self-management</strong>
                <small>
                  The agent may rewrite its own identity and skills. Providers and permissions stay
                  yours.
                </small>
              </span>
            </label>
            <label className="check-row">
              <input name="shell" type="checkbox" defaultChecked={profile.allowShell} />
              <span>
                <strong>Allow the terminal and files</strong>
                <small>
                  The agent may read files, write files and run commands on this machine, with the
                  privileges of whoever started the gateway. This holds over WhatsApp and Telegram
                  too: any approved contact gains that path.
                </small>
              </span>
            </label>
            <label className="check-row">
              <input name="webSearch" type="checkbox" defaultChecked={profile.allowWebSearch} />
              <span>
                <strong>Allow web search</strong>
                <small>
                  The agent may search the internet and read public pages, through the search key
                  under Providers. Pages are written by strangers and can try to steer it.
                </small>
              </span>
            </label>
          </div>
        </div>
        <div className="save-bar">
          <span>Changes apply to new runs</span>
          <Button type="submit" busy={busy}>
            <Save size={16} />
            Save profile
          </Button>
        </div>
      </form>

      <SectionHeading
        title="Danger zone"
        description="This deletes the profile itself, not just what it says."
      />
      <div className="save-bar">
        <span>
          Every session, memory, message, channel, contact and run this profile has ever held is
          removed with it. There is no undo.
        </span>
        <Button variant="danger" onClick={() => setDeleting(true)}>
          <Trash2 size={16} />
          Delete profile
        </Button>
      </div>

      {deleting && (
        <Confirm
          title={`Delete ${profile.name}?`}
          description="Every memory, chat history, message, channel connection, contact and run tied to this profile is deleted along with it. This cannot be undone."
          busy={busy}
          close={() => setDeleting(false)}
          confirm={async () => {
            if (await deleteProfile(profile.id)) {
              setDeleting(false);
            }
          }}
        />
      )}
    </>
  );
}
