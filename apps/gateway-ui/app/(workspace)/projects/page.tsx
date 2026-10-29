'use client';

import { FolderGit2 } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import {
  Button,
  Empty,
  Field,
  GitHubLogo,
  ResourceRow,
  SectionHeading,
} from '../../../components/ui';
import { Select, type SelectOption } from '../../../components/ui/select';
import type { GitHubIntegration, GitHubRepository } from '../../../lib/api';
import { useSection, useWorkspace } from '../../../lib/workspace';

export default function ProjectsPage() {
  const { profile, data, api, mutate } = useSection();
  const { refresh, setNotice } = useWorkspace();
  const [name, setName] = useState('');
  const [integration, setIntegration] = useState<GitHubIntegration>();
  const [accountId, setAccountId] = useState('');
  const [repositoryId, setRepositoryId] = useState('');
  const [repositories, setRepositories] = useState<GitHubRepository[]>([]);
  const [loadingRepositories, setLoadingRepositories] = useState(false);

  const loadIntegration = useCallback(() => {
    void api
      .githubIntegration()
      .then((result) => {
        setIntegration(result);
        setAccountId((current) =>
          result.accounts.some((account) => account.id === current)
            ? current
            : (result.accounts[0]?.id ?? ''),
        );
      })
      .catch((error: unknown) =>
        setNotice({
          text: error instanceof Error ? error.message : 'GitHub integration could not load.',
          error: true,
        }),
      );
  }, [api, setNotice]);

  useEffect(() => loadIntegration(), [loadIntegration]);

  useEffect(() => {
    setRepositoryId('');
    if (!accountId) {
      setRepositories([]);
      return;
    }
    let active = true;
    setLoadingRepositories(true);
    void api
      .githubRepositories(accountId)
      .then((result) => {
        if (active) setRepositories(result);
      })
      .catch((error: unknown) => {
        if (active) {
          setRepositories([]);
          setNotice({
            text: error instanceof Error ? error.message : 'GitHub repositories could not load.',
            error: true,
          });
        }
      })
      .finally(() => {
        if (active) setLoadingRepositories(false);
      });
    return () => {
      active = false;
    };
  }, [accountId, api, setNotice]);

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
              setRepositoryId('');
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
                setRepositoryId(value);
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
          <Link href="/integrations" className="text-accent underline">
            Integrations
          </Link>
          . Its repositories will be available to every agent.
        </Empty>
      )}
      {data.projects.length ? (
        <div className="resource-list">
          {data.projects.map((project) => (
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
                      setNotice(undefined);
                      try {
                        const session = await api.createGatewaySession(profile.id, project.id);
                        await refresh();
                        window.location.assign(`/sessions?session=${session.id}`);
                      } catch (error) {
                        setNotice({
                          text:
                            error instanceof Error
                              ? error.message
                              : 'The chat could not be created.',
                          error: true,
                        });
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
