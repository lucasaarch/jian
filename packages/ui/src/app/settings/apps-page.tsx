'use client';

import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import {
  type FieldOption,
  FilterSelect,
  SearchField,
  SettingsCardSkeleton,
  SettingsCards,
  SettingsPageSkeleton,
} from '../../kit';
import { queries } from '../../lib/query/profile';
import { matchesQuery } from '../../lib/search';
import { useActions } from '../../lib/workspace';
import { GITHUB_DESCRIPTION, GitHubCard, githubOffered } from './github-card';
import { McpAppCard } from './mcp-app-card';
import { CATEGORIES, type Category, MCP_APPS } from './mcp-apps';
import { X_DESCRIPTION, XCard, xOffered } from './x-card';

type App = {
  id: string;
  name: string;
  description: string;
  category: Category;
  offered: boolean;
  card: ReactNode;
};

const ALL = 'all';

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
 * The apps the gateway connects with the owner's own accounts, shared by every agent, a card each,
 * among those this gateway can do: GitHub and X are its own, the rest a service's MCP server. A search over their names, categories and what they give, and
 * a category list, narrow the cards; the list offers only categories that hold an app.
 */
export function AppsPage() {
  const { api } = useActions();
  const github = useQuery(queries.githubIntegration());
  const x = useQuery(queries.xIntegration());
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string>(ALL);

  const every: App[] = [
    {
      id: 'github',
      name: 'GitHub',
      description: GITHUB_DESCRIPTION,
      category: 'development',
      offered: githubOffered(github.data),
      card: <GitHubCard api={api} />,
    },
    {
      id: 'x',
      name: 'X',
      description: X_DESCRIPTION,
      category: 'social',
      offered: xOffered(x.data),
      card: <XCard api={api} />,
    },
    // A service's own MCP server under a card, which every gateway can connect.
    ...MCP_APPS.map((app) => ({ ...app, offered: true, card: <McpAppCard app={app} /> })),
  ];
  const apps = every.filter((app) => app.offered);

  // Until GitHub and X have answered, their cards would land in the grid after the rest.
  if (github.isPending || x.isPending) return <AppsWaiting />;

  const categories: FieldOption[] = [
    { value: ALL, label: 'All categories' },
    ...(Object.keys(CATEGORIES) as Category[])
      .filter((key) => apps.some((app) => app.category === key))
      .map((key) => ({ value: key, label: CATEGORIES[key] })),
  ];
  const shown = apps.filter(
    (app) =>
      (category === ALL || app.category === category) &&
      matchesQuery(`${app.name} ${CATEGORIES[app.category]} ${app.description}`, query),
  );

  return (
    <div className="grid gap-4">
      <div className="flex items-center gap-2">
        <SearchField
          label="Search apps"
          value={query}
          onValueChange={setQuery}
          className="flex-1"
        />
        <FilterSelect
          label="Category"
          value={category}
          options={categories}
          onValueChange={setCategory}
        />
      </div>
      {shown.length ? (
        <SettingsCards>
          {shown.map((app) => (
            <div key={app.id} className="contents">
              {app.card}
            </div>
          ))}
        </SettingsCards>
      ) : (
        <p className="px-1 text-sm text-muted">No app matches.</p>
      )}
    </div>
  );
}
