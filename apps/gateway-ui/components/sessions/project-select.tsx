'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderKanban } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Badge, GitHubLogo } from '@/components/ui';
import { Select, type SelectOption } from '@/components/ui/select';
import type { GatewayApi, Project } from '@/lib/api';
import { repositorySlug } from '@/lib/format';
import { settingsPath } from '@/lib/navigation';
import { keys } from '@/lib/query/keys';
import { queries } from '@/lib/query/profile';
import { notifyError } from '@/lib/workspace';

/** A project the repository list does not hold: an older one, or a repository no longer granted. */
const PROJECT = 'project:';

/**
 * The repository a chat works on. A project is its repository, so the list is the repositories
 * of every connected GitHub account; choosing one opens this agent's project for it, the same
 * one each time.
 */
export function ProjectSelect({
  api,
  profileId,
  projects,
  projectId,
  onChange,
}: {
  api: GatewayApi;
  profileId: string;
  projects: Project[];
  projectId: string | null;
  onChange: (projectId: string | null) => void;
}) {
  const client = useQueryClient();
  const [opening, setOpening] = useState(false);
  // Read as the composer appears, not when the list opens, so the list is ready when it does.
  const { data: repositories = [] } = useQuery(queries.githubRepositories());
  const { data: integration } = useQuery(queries.githubIntegration());
  const connected = Boolean(integration?.accounts.length);
  // One repository reached through two accounts is still one project.
  const listed = repositories.filter(
    (repository, index) => repositories.findIndex((item) => item.id === repository.id) === index,
  );
  const project = projects.find((item) => item.id === projectId);
  const inList = listed.some((repository) => repository.id === project?.githubRepositoryId);
  const value = !project
    ? ''
    : inList
      ? String(project.githubRepositoryId)
      : `${PROJECT}${project.id}`;
  const options: SelectOption[] = [
    { value: '', label: 'No project', icon: <FolderKanban size={16} /> },
    ...(project && !inList
      ? [
          {
            value: `${PROJECT}${project.id}`,
            label: repositorySlug(project.repositoryUrl),
            icon: <GitHubLogo size={16} />,
          },
        ]
      : []),
    ...listed.map((repository) => ({
      value: String(repository.id),
      label: repository.fullName,
      icon: <GitHubLogo size={16} />,
      badge: <Badge dot={false}>{repository.private ? 'Private' : 'Public'}</Badge>,
    })),
  ];

  const choose = async (choice: string) => {
    if (choice === value || choice.startsWith(PROJECT)) return;
    if (!choice) return onChange(null);

    const repository = listed.find((item) => String(item.id) === choice);
    if (!repository) return;

    setOpening(true);
    try {
      const opened = await api.ensureProject(profileId, {
        githubAccountId: repository.accountId,
        githubRepositoryId: repository.id,
      });
      await client.invalidateQueries({ queryKey: keys.projects(profileId) });
      onChange(opened.id);
    } catch (error) {
      notifyError(error, 'The repository could not be opened as a project.');
    } finally {
      setOpening(false);
    }
  };

  return (
    <Select
      aria-label="Project"
      variant="ghost"
      popup="content"
      value={value}
      disabled={opening}
      onValueChange={(choice) => void choose(choice)}
      options={options}
      renderValue={(option) => (option?.value ? option.label : 'Project')}
      {...(connected
        ? {}
        : {
            footer: (close: () => void) => (
              <Link href={settingsPath('integrations')} onClick={close}>
                <GitHubLogo size={16} />
                Connect GitHub to work on a repository
              </Link>
            ),
          })}
    />
  );
}
