'use client';

import { useQuery } from '@tanstack/react-query';
import { FolderGit2 } from 'lucide-react';
import Link from 'next/link';
import { useId, useState } from 'react';
import { Button, buttonClass, Field, Modal } from '@/components/ui';
import { Select, type SelectOption } from '@/components/ui/select';
import type { GatewayApi, Project } from '@/lib/api';
import { settingsPath } from '@/lib/navigation';
import { useReportFailure } from '@/lib/query/notify';
import { queries } from '@/lib/query/profile';
import { notifyError } from '@/lib/workspace';

/**
 * A project for this agent: a name and one repository. The repositories of every connected
 * GitHub account are one list, named `owner/repo`; the account a project goes through follows
 * from the repository picked.
 */
export function NewProjectDialog({
  api,
  profileId,
  close,
  created,
}: {
  api: GatewayApi;
  profileId: string;
  close: () => void;
  created: (project: Project) => Promise<void> | void;
}) {
  const form = useId();
  const { data: integration, isPending: loadingAccounts } = useReportFailure(
    useQuery(queries.githubIntegration()),
    'GitHub integration could not load.',
  );
  const connected = Boolean(integration?.accounts.length);
  const { data: repositories = [], isFetching: loadingRepositories } = useReportFailure(
    useQuery({ ...queries.githubRepositories(), enabled: connected }),
    'GitHub repositories could not load.',
  );
  const [name, setName] = useState('');
  const [chosenKey, setChosenKey] = useState('');
  const [busy, setBusy] = useState(false);
  // One repository can be reached through two accounts; the pair names the choice.
  const keyOf = (repository: { accountId: string; id: number }) =>
    `${repository.accountId}:${repository.id}`;
  const chosen = repositories.find((repository) => keyOf(repository) === chosenKey);
  const options: SelectOption[] = repositories.map((repository) => ({
    value: keyOf(repository),
    label: repository.fullName,
    detail: [repository.private ? 'Private' : 'Public', repository.description]
      .filter(Boolean)
      .join(' · '),
    icon: <FolderGit2 size={16} />,
  }));

  if (!loadingAccounts && !connected) {
    return (
      <Modal
        title="New project"
        description="A project is a repository its chats work in."
        close={close}
        footer={
          <Link href={settingsPath('integrations')} className={buttonClass('primary')}>
            Open Integrations
          </Link>
        }
      >
        <p>Connect a GitHub account under Integrations to choose a repository.</p>
      </Modal>
    );
  }

  const submit = async () => {
    if (!chosen || !name.trim()) return;
    setBusy(true);
    try {
      const project = await api.createProject(profileId, {
        name: name.trim(),
        githubAccountId: chosen.accountId,
        githubRepositoryId: chosen.id,
      });
      await created(project);
      close();
    } catch (error) {
      notifyError(error, 'The project could not be created.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="New project"
      description="A project is a repository its chats work in."
      close={close}
      footer={
        <>
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" form={form} busy={busy} disabled={!name.trim() || !chosen}>
            Create project
          </Button>
        </>
      }
    >
      <form
        id={form}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field label="Project name">
          <input
            required
            maxLength={100}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="My project"
          />
        </Field>
        <Field label="Repository">
          <Select
            aria-label="Repository"
            value={chosenKey}
            disabled={loadingRepositories || !repositories.length}
            onValueChange={(value) => {
              setChosenKey(value);
              const repository = repositories.find((item) => keyOf(item) === value);
              if (repository && !name.trim()) setName(repository.name);
            }}
            options={options}
            placeholder={loadingRepositories ? 'Loading repositories' : 'Choose a repository'}
          />
        </Field>
      </form>
    </Modal>
  );
}
