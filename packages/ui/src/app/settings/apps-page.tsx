'use client';

import { useQuery } from '@tanstack/react-query';
import { SettingsCardSkeleton, SettingsCards, SettingsPageSkeleton } from '../../kit';
import { queries } from '../../lib/query/profile';
import { useActions } from '../../lib/workspace';
import { GitHubCard, githubOffered } from './github-card';
import { XCard, xOffered } from './x-card';

/** Apps while the page is read: a card for each app a gateway can offer. */
export function AppsWaiting() {
  return (
    <SettingsPageSkeleton label="Loading apps…">
      <SettingsCards>
        <SettingsCardSkeleton index={3} />
        <SettingsCardSkeleton index={1} />
      </SettingsCards>
    </SettingsPageSkeleton>
  );
}

/**
 * The apps the gateway connects with the owner's own accounts, shared by every agent: GitHub and
 * X, a card each, among those this gateway can do.
 */
export function AppsPage() {
  const { api } = useActions();
  const github = useQuery(queries.githubIntegration());
  const x = useQuery(queries.xIntegration());
  const offersGithub = githubOffered(github.data);
  const offersX = xOffered(x.data);

  if (!offersGithub && !offersX) {
    // Until both have answered, an app may still turn out to be offered.
    if (github.isPending || x.isPending) return <AppsWaiting />;
    return <p className="px-1 text-sm text-muted">This gateway offers no apps to connect.</p>;
  }

  return (
    <SettingsCards>
      <GitHubCard api={api} />
      <XCard api={api} />
    </SettingsCards>
  );
}
