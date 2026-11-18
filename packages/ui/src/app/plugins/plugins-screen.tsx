'use client';

import { Menu } from '@base-ui/react/menu';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Cable, ChevronDown, Download, PenLine } from 'lucide-react';
import { useEffect, useEffectEvent, useState } from 'react';
import { filterSkills, type SkillFilter, skillFilters } from '../../components/skills/skill-items';
import { SKILL_LIMIT } from '../../components/skills/skill-list';
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
import { usePathname, useRouter, useSearchParams } from '../../platform/navigation';
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
import { SkillOverlays, usePluginSkills } from './plugin-skills';
import { SkillsTab, skillRow } from './skills-tab';

type Tab = 'all' | 'connectors' | 'skills';

const TABS: { value: Tab; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'connectors', label: 'Connectors' },
  { value: 'skills', label: 'Skills' },
];

const isTab = (value: string | null): value is Tab => TABS.some((tab) => tab.value === value);

/** How many of a kind All shows before it sends the owner to the rest. */
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

/** What leads from a few of a kind on All to its own tab, at the right of the section's title. */
function ShowAll({ onClick }: { onClick: () => void }) {
  return (
    <Action tone="quiet" size="small" onClick={onClick}>
      Show all
      <ArrowRight size={13} aria-hidden="true" />
    </Action>
  );
}

/**
 * What the agents can be given, in place of the chat: the connectors, which are Jian's own apps
 * and the MCP servers the owner adds by hand, and the skills, written here, by an agent, or
 * imported, beside the ones built into Jian. A page of the kit's one anatomy: a search narrows
 * the rows, the tabs choose the kind, each kind's tab has its own filter, and a row opens what
 * it names. Both belong to the installation, so every agent shows the same; the page goes with
 * no conversation, so it has no Inspector beside it. `?tab=` in the address opens a tab.
 */
export function PluginsScreen() {
  useNoInspector();
  const github = useQuery(queries.githubIntegration());
  const x = useQuery(queries.xIntegration());
  const servers = useQuery(queries.mcpServers());
  const skills = usePluginSkills();
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const asked = params.get('tab');
  const [tab, setTab] = useState<Tab>(isTab(asked) ? asked : 'all');
  const [query, setQuery] = useState('');
  // Each kind's filter is its tab's alone: All narrows by the search only.
  const [connectorFilter, setConnectorFilter] = useState<string>(ALL);
  const [skillFilter, setSkillFilter] = useState<SkillFilter>('all');
  const [adding, setAdding] = useState(false);
  // The connector open, kept while its dialog closes; read again from the list while it is
  // there, since connecting changes it under the dialog.
  const [kept, setKept] = useState<Connector>();
  const [open, setOpen] = useState(false);

  // An address that names a tab opens it, also when the screen is already up.
  useEffect(() => {
    if (isTab(asked)) setTab(asked);
  }, [asked]);
  const choose = (next: Tab) => {
    setTab(next);
    // The address stops naming a tab the owner left, so asking for that tab again opens it.
    if (asked) router.replace(pathname);
  };

  // Until GitHub, X and the saved servers have answered, rows would land in the list and then
  // jump to where they belong.
  const connectorsReady = !github.isPending && !x.isPending && Boolean(servers.data);
  const ready = (tab === 'skills' || connectorsReady) && (tab === 'connectors' || !skills.loading);
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
    if (connectorsReady) showReturned();
  }, [connectorsReady, returned]);

  const searching = Boolean(query.trim());
  const shown = narrowConnectors(connectors, query, tab === 'connectors' ? connectorFilter : ALL);
  const shownSkills = filterSkills(skills.items, query, tab === 'skills' ? skillFilter : 'all');
  const connected = shown.filter((connector) => connector.connected);
  const available = shown.filter((connector) => !connector.connected);
  // A search is never cut to the first few: what it found is all there.
  const few = <T,>(items: T[]) => (searching ? items : items.slice(0, PREVIEW));
  const skillsFailed = skills.error && (
    <p role="alert" className="text-sm text-muted">
      {skills.error}
    </p>
  );
  const none = (what: string, narrowed: boolean) => (
    <p className="text-sm text-muted">{narrowed ? `No ${what} matches.` : `No ${what}s yet.`}</p>
  );

  return (
    <div className="flex h-full min-h-0">
      <PageBody wide labelledBy="plugins-title">
        <PageHeading
          id="plugins-title"
          title="Plugins"
          description="What your agents can use. Connectors and skills are shared by every agent."
        />
        <PageToolbar>
          <SearchField
            label="Search plugins"
            className="min-w-44 flex-1"
            value={query}
            onValueChange={setQuery}
          />
          <Segmented label="Show" value={tab} options={TABS} onChange={choose} />
          {tab === 'connectors' && (
            <FilterSelect
              label="Filter connectors"
              value={connectorFilter}
              options={connectorFilters(connectors)}
              onValueChange={setConnectorFilter}
            />
          )}
          {tab === 'skills' && (
            <FilterSelect
              label="Filter skills"
              value={skillFilter}
              options={skillFilters}
              onValueChange={(next) => setSkillFilter(next as SkillFilter)}
            />
          )}
          <Menu.Root>
            <Menu.Trigger render={<Action tone="outline" size="field" />}>
              Add
              <ChevronDown size={14} aria-hidden="true" />
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Positioner side="bottom" align="end" sideOffset={6} className="z-50">
                <Menu.Popup className={menuPopup}>
                  <MenuEntry
                    icon={<Cable size={14} />}
                    // Its form is written into the saved servers, so it waits for them.
                    disabled={!connectorsReady}
                    onClick={() => setAdding(true)}
                  >
                    Custom connector
                  </MenuEntry>
                  <MenuEntry
                    icon={<PenLine size={14} />}
                    disabled={skills.full}
                    onClick={skills.create}
                  >
                    {skills.full ? `Create skill (library full at ${SKILL_LIMIT})` : 'Create skill'}
                  </MenuEntry>
                  <MenuEntry icon={<Download size={14} />} onClick={skills.startImport}>
                    Import skill
                  </MenuEntry>
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </Menu.Root>
        </PageToolbar>
        {tab !== 'skills' && servers.isError && !servers.data ? (
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
          <>
            {skillsFailed}
            <SkillsTab items={shownSkills} onOpen={skills.show} />
            {!shownSkills.length &&
              !skills.error &&
              none('skill', searching || skillFilter !== 'all')}
          </>
        ) : tab === 'connectors' ? (
          shown.length ? (
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
            none('connector', searching || connectorFilter !== ALL)
          )
        ) : (
          <>
            {shown.length > 0 && (
              <PluginSection
                title="Connectors"
                action={
                  shown.length > few(shown).length && (
                    <ShowAll onClick={() => choose('connectors')} />
                  )
                }
              >
                <PluginList label="Connectors" items={few(shown).map(rowOf)} onOpen={show} />
              </PluginSection>
            )}
            {(shownSkills.length > 0 || skillsFailed) && (
              <PluginSection
                title="Skills"
                action={
                  shownSkills.length > few(shownSkills).length && (
                    <ShowAll onClick={() => choose('skills')} />
                  )
                }
              >
                {skillsFailed || (
                  <PluginList
                    label="Skills"
                    items={few(shownSkills).map(skillRow)}
                    onOpen={skills.show}
                  />
                )}
              </PluginSection>
            )}
            {!shown.length && !shownSkills.length && !skills.error && none('plugin', searching)}
          </>
        )}
      </PageBody>
      {connectorsReady && (
        <>
          <ConnectorDialog
            connector={connectors.find((item) => item.id === kept?.id) ?? kept}
            open={open}
            onOpenChange={setOpen}
          />
          <McpEditor editing="new" open={adding} onOpenChange={setAdding} />
        </>
      )}
      <SkillOverlays {...skills.overlays} />
    </div>
  );
}
