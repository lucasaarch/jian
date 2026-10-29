'use client';

import { useQuery } from '@tanstack/react-query';
import { FolderGit2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { agentPath } from '@/lib/navigation';
import { useAgent, useProjects } from '@/lib/query/agent';
import { useReportFailure } from '@/lib/query/notify';
import { queries } from '@/lib/query/profile';
import { notifyError, useActions, useRefresh } from '@/lib/workspace';
import {
  Button,
  Empty,
  Field,
  GitHubLogo,
  ResourceRow,
  SectionHeading,
} from '../../../../../components/ui';
import { Select, type SelectOption } from '../../../../../components/ui/select';

export default function ProjectsPage() {
  const profile = useAgent();
  const projects = useProjects();
  const { api, mutate } = useActions();
  const refresh = useRefresh();
  const router = useRouter();
  const [name, setName] = useState('');
  const { data: integration } = useReportFailure(
    useQuery(queries.githubIntegration()),
    'GitHub integration could not load.',
  );
  const [chosenAccount, setAccountId] = useState('');
  // The account the owner chose while it is still installed; otherwise the first one.
  const accountId = integration?.accounts.some((account) => account.id === chosenAccount)
    ? chosenAccount
    : (integration?.accounts[0]?.id ?? '');
  const [chosenRepository, setChosenRepository] = useState({ accountId: '', repositoryId: '' });
  // A repository belongs to the account it was chosen under; another account starts empty.
  const repositoryId =
    chosenRepository.accountId === accountId ? chosenRepository.repositoryId : '';
  const { data: repositories = [], isFetching: loadingRepositories } = useReportFailure(
    useQuery({ ...queries.githubRepositories(accountId), enabled: Boolean(accountId) }),
    'GitHub repositories could not load.',
  );

  const accountOptions: SelectOption[] = (integration?.accounts ?? []).map((account) => ({
    value: account.id,
    label: account.login,
    detail: account.type === 'Organization' ? 'Organization' : 'GitHub account',
    icon: <GitHubLogo size={16} />,
  }));
  const repositoryOptions: SelectOption[] = repositories.map((repository) => ({
    value: String(repository.id),
    label: repository.fullName,
    detail: [repository.private ? 'Private' : 'Public', repository.description]
      .filter(Boolean)
      .join(' · '),
    icon: <FolderGit2 size={16} />,
  }));

  return (
    <>
      <SectionHeading
        title="Projects"
        description="Keep coding conversations grouped by repository."
      />
      {integration?.accounts.length ? (
        <form
          className="identity-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!accountId || !repositoryId) return;
            void mutate(async () => {
              await api.createProject(profile.id, {
                name,
                githubAccountId: accountId,
                githubRepositoryId: Number(repositoryId),
              });
              setName('');
              setChosenRepository({ accountId: '', repositoryId: '' });
              await refresh();
            }, 'Project created.');
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
          {integration.accounts.length > 1 && (
            <Field label="GitHub account">
              <Select
                aria-label="GitHub account"
                value={accountId}
                onValueChange={setAccountId}
                options={accountOptions}
                placeholder="Choose an account"
              />
            </Field>
          )}
          <Field
            label="Repository"
            hint="Choose a repository available to the selected GitHub account."
          >
            <Select
              aria-label="GitHub repository"
              value={repositoryId}
              disabled={loadingRepositories || !repositories.length}
              onValueChange={(value) => {
                setChosenRepository({ accountId, repositoryId: value });
                const repository = repositories.find((item) => String(item.id) === value);
                if (repository && !name.trim()) setName(repository.name);
              }}
              options={repositoryOptions}
              placeholder={loadingRepositories ? 'Loading repositories' : 'Choose a repository'}
              searchThreshold={8}
            />
          </Field>
          <Button type="submit" disabled={!name.trim() || !accountId || !repositoryId}>
            Add project
          </Button>
        </form>
      ) : (
        <Empty title="Connect GitHub to add a project">
          Connect an account once in{' '}
          <Link href={agentPath(profile.id, 'integrations')} className="text-accent underline">
            Integrations
          </Link>
          . Its repositories will be available to every agent.
        </Empty>
      )}
      {projects.length ? (
        <div className="resource-list">
          {projects.map((project) => (
            <ResourceRow
              key={project.id}
              id={`project-${project.id}`}
              icon={<FolderGit2 size={20} strokeWidth={1.6} />}
              name={project.name}
              description={project.repositoryUrl}
              actions={
                <Button
                  onClick={() =>
                    void (async () => {
                      try {
                        const session = await api.createGatewaySession(profile.id, project.id);
                        await refresh();
                        router.push(agentPath(profile.id, `sessions/${session.id}`));
                      } catch (error) {
                        notifyError(error, 'The chat could not be created.');
                      }
                    })()
                  }
                >
                  New chat
                </Button>
              }
            />
          ))}
        </div>
      ) : (
        <Empty title="No projects yet">
          Add a repository to organize its coding conversations.
        </Empty>
      )}
    </>
  );
}
