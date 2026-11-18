'use client';

import { Menu } from '@base-ui/react/menu';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Cable, ChevronDown } from 'lucide-react';
import { useEffect, useEffectEvent, useState } from 'react';
import {
  Action,
  FilterSelect,
  MenuEntry,
  menuPopup,
  PageBody,
  PageHeading,
  PageToolbar,
  SearchField,
  Segmented,
  SettingsGroup,
  SettingsRowsSkeleton,
  SkeletonRegion,
} from '../../kit';
import { queries } from '../../lib/query/profile';
import { useNoInspector } from '../../lib/stores/screen';
import { useSearchParams } from '../../platform/navigation';
import { ConnectorDialog, ConnectorIcon } from './connector-dialog';
import {
  ALL,
  type Connector,
  connectorFilters,
  connectorMeta,
  connectorsOf,
  isVerified,
  narrowConnectors,
} from './connectors';
import { McpEditor } from './custom-connector';
import { type PluginItem, PluginList, PluginSection } from './plugin-list';

type Tab = 'all' | 'connectors' | 'skills';

const TABS: { value: Tab; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'connectors', label: 'Connectors' },
  { value: 'skills', label: 'Skills' },
];

/** How many connectors All shows before it sends the owner to the rest. */
const PREVIEW = 8;

const rowOf = (connector: Connector): PluginItem => ({
  id: connector.id,
  icon: <ConnectorIcon connector={connector} />,
  name: connector.name,
  verified: isVerified(connector),
  description: connector.description,
  meta: connectorMeta(connector),
  ...(connector.connected ? { status: 'Connected' } : {}),
});

/**
 * What the agents can be given, in place of the chat: the connectors, which are Jian's own apps
 * and the MCP servers the owner adds by hand, and the skills once they move here. A page of the
 * kit's one anatomy: a search and a filter narrow the rows, the tabs choose the kind, and a row
 * opens what connects it. Connectors belong to the installation, so every agent shows the same;
 * the page goes with no conversation, so it has no Inspector beside it.
 */
export function PluginsScreen() {
  useNoInspector();
  const github = useQuery(queries.githubIntegration());
  const x = useQuery(queries.xIntegration());
  const servers = useQuery(queries.mcpServers());
  const params = useSearchParams();
  const [tab, setTab] = useState<Tab>('all');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<string>(ALL);
  const [adding, setAdding] = useState(false);
  // The connector open, kept while its dialog closes; read again from the list while it is
  // there, since connecting changes it under the dialog.
  const [kept, setKept] = useState<Connector>();
  const [open, setOpen] = useState(false);

  // Until GitHub, X and the saved servers have answered, rows would land in the list and then
  // jump to where they belong.
  const ready = !github.isPending && !x.isPending && Boolean(servers.data);
  const connectors = connectorsOf({
    github: github.data,
    x: x.data,
    servers: servers.data ?? [],
  });
  const show = (id: string) => {
    const connector = connectors.find((item) => item.id === id);
    if (!connector) return;
    setKept(connector);
    setOpen(true);
  };

  // GitHub and X send the owner back with the outcome in the query. It is said by the
  // connector's own card, so the connector opens for it to be read there.
  const returned = params.has('github') ? 'github' : params.has('x') ? 'x' : undefined;
  const showReturned = useEffectEvent(() => returned && show(returned));
  // biome-ignore lint/correctness/useExhaustiveDependencies: opened once per return, when the list is in.
  useEffect(() => {
    if (ready) showReturned();
  }, [ready, returned]);

  const narrowed = Boolean(query.trim()) || filter !== ALL;
  const shown = narrowConnectors(connectors, query, filter);
  const preview = narrowed ? shown : shown.slice(0, PREVIEW);
  const connected = shown.filter((connector) => connector.connected);
  const available = shown.filter((connector) => !connector.connected);
  const none = (
    <p className="text-sm text-muted">
      {narrowed ? 'No connector matches.' : 'No connectors yet.'}
    </p>
  );

  return (
    <div className="flex h-full min-h-0">
      <PageBody wide labelledBy="plugins-title">
        <PageHeading
          id="plugins-title"
          title="Plugins"
          description="What your agents can use. Connectors are shared by every agent."
        />
        <PageToolbar>
          <SearchField
            label="Search plugins"
            className="min-w-44 flex-1"
            value={query}
            onValueChange={setQuery}
          />
          <Segmented label="Show" value={tab} options={TABS} onChange={setTab} />
          {tab !== 'skills' && (
            <FilterSelect
              label="Filter connectors"
              value={filter}
              options={connectorFilters(connectors)}
              onValueChange={setFilter}
            />
          )}
          <Menu.Root>
            <Menu.Trigger render={<Action tone="outline" size="small" className="h-8" />}>
              Add
              <ChevronDown size={13} aria-hidden="true" />
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Positioner side="bottom" align="end" sideOffset={6} className="z-50">
                <Menu.Popup className={menuPopup}>
                  <MenuEntry icon={<Cable size={14} />} onClick={() => setAdding(true)}>
                    Custom connector
                  </MenuEntry>
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </Menu.Root>
        </PageToolbar>
        {servers.isError && !servers.data ? (
          <div className="grid justify-items-start gap-3">
            <p role="alert" className="text-sm text-muted">
              {servers.error instanceof Error
                ? servers.error.message
                : 'The connectors could not be read.'}
            </p>
            <Action onClick={() => void servers.refetch()}>Try again</Action>
          </div>
        ) : !ready ? (
          <SkeletonRegion label="Loading plugins…">
            <SettingsGroup>
              <SettingsRowsSkeleton count={4} />
            </SettingsGroup>
          </SkeletonRegion>
        ) : tab === 'skills' ? (
          <p className="text-sm text-muted">Skills move here soon.</p>
        ) : tab === 'all' ? (
          <PluginSection
            title="Connectors"
            action={
              shown.length > preview.length && (
                <Action tone="quiet" size="small" onClick={() => setTab('connectors')}>
                  Show all
                  <ArrowRight size={13} aria-hidden="true" />
                </Action>
              )
            }
          >
            {preview.length ? (
              <PluginList label="Connectors" items={preview.map(rowOf)} onOpen={show} />
            ) : (
              none
            )}
          </PluginSection>
        ) : shown.length ? (
          <>
            {connected.length > 0 && (
              <PluginSection title="Connected">
                <PluginList label="Connected" items={connected.map(rowOf)} onOpen={show} />
              </PluginSection>
            )}
            {available.length > 0 && (
              <PluginSection title="Available">
                <PluginList label="Available" items={available.map(rowOf)} onOpen={show} />
              </PluginSection>
            )}
          </>
        ) : (
          none
        )}
      </PageBody>
      {ready && (
        <>
          <ConnectorDialog
            connector={connectors.find((item) => item.id === kept?.id) ?? kept}
            open={open}
            onOpenChange={setOpen}
          />
          <McpEditor editing="new" open={adding} onOpenChange={setAdding} />
        </>
      )}
    </div>
  );
}
