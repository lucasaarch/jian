'use client';

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { GithubIntegration } from '../../components/integrations/github-actions';
import { useGithubOutcome } from '../../components/integrations/github-outcome';
import { useXOutcome, type XIntegration } from '../../components/integrations/x-actions';
import {
  Action,
  BackLink,
  PageBody,
  SettingsGroup,
  SettingsRowsSkeleton,
  SkeletonRegion,
} from '../../kit';
import { connectorPath, pluginsPath } from '../../lib/navigation';
import { queries } from '../../lib/query/profile';
import { useNoInspector } from '../../lib/stores/screen';
import { useProfileId } from '../../lib/workspace';
import { useRouter, useSearchParams } from '../../platform/navigation';
import { AppConnector } from './connector-app';
import { AwsConnector } from './connector-aws';
import { CustomConnector, type Leave } from './connector-custom';
import { GithubConnector } from './connector-github';
import { XConnector } from './connector-x';
import { type Connector, connectorsOf } from './connectors';

/** What a connector is underneath decides what its page holds. */
function ConnectorBody({
  connector,
  github,
  x,
  back,
  leave,
}: {
  connector: Connector;
  github: GithubIntegration | undefined;
  x: XIntegration | undefined;
  back: () => void;
  leave: Leave;
}) {
  const { source } = connector;
  if (source.kind === 'github')
    return github ? (
      <GithubConnector connector={connector} integration={github} back={back} />
    ) : null;
  if (source.kind === 'x')
    return x ? <XConnector connector={connector} integration={x} back={back} /> : null;
  if (source.kind === 'aws') return <AwsConnector connector={connector} back={back} />;
  if (source.kind === 'app')
    return <AppConnector connector={connector} app={source.app} back={back} />;
  return <CustomConnector connector={connector} server={source.server} back={back} leave={leave} />;
}

/**
 * One connector, on a page of its own under Plugins, in the conversation's place, as a skill
 * has: what it gives the agents, its accounts and its sign-in, beside what is known about it.
 * Everything that connects or changes it is in the page; only a removal asks in a dialog first.
 * `id` is the address's: `github`, `x`, `aws`, an app of the catalog, or `custom:<name>` for a
 * server the owner added, so a connector that is not there, or not offered by this gateway, is
 * said so with the way back. GitHub and X send the owner back here with the outcome in the
 * query, which is said once and dropped from the address. `?from=connectors` is the tab the
 * page was opened from, where the way back leads.
 */
export function ConnectorPage({ id }: { id: string }) {
  useNoInspector();
  useGithubOutcome();
  useXOutcome();
  const github = useQuery(queries.githubIntegration());
  const x = useQuery(queries.xIntegration());
  const servers = useQuery(queries.mcpServers());
  const profileId = useProfileId();
  const router = useRouter();
  const from = useSearchParams().get('from') === 'connectors' ? 'connectors' : undefined;
  // A removal or a new name takes the server from this address a moment before the page goes
  // where it now is: nothing is said of the connector that is missing meanwhile.
  const [leaving, setLeaving] = useState(false);
  const plugins = profileId ? pluginsPath(profileId, from) : '/';
  const back = () => router.push(plugins);
  const leave: Leave = async (change, renamedTo) => {
    setLeaving(true);
    const ok = await change();
    if (!ok) setLeaving(false);
    else if (renamedTo !== undefined && profileId)
      router.replace(connectorPath(profileId, `custom:${renamedTo}`, from));
    // Its page is gone with it: back to the list, in this page's place in the history.
    else router.replace(plugins);
    return ok;
  };

  // Until GitHub, X and the saved servers have answered, what the connector is cannot be told.
  const ready = !github.isPending && !x.isPending && Boolean(servers.data);
  const connector = ready
    ? connectorsOf({ github: github.data, x: x.data, servers: servers.data ?? [] }).find(
        (item) => item.id === id,
      )
    : undefined;
  // A read that failed is not a connector that is missing. X is left out: a gateway that does
  // not have it answers with an error, which is how it says so.
  const failed = servers.isError ? servers : id === 'github' && github.isError ? github : undefined;

  return (
    <div className="flex h-full min-h-0">
      <PageBody {...(connector ? { labelledBy: 'connector-title' } : { label: 'Connector' })}>
        {connector ? (
          <ConnectorBody
            connector={connector}
            github={github.data}
            x={x.data}
            back={back}
            leave={leave}
          />
        ) : (
          <div className="grid grid-cols-1 gap-3">
            <BackLink onClick={back}>Plugins</BackLink>
            {failed ? (
              <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-muted">
                {failed === github
                  ? 'GitHub could not be read.'
                  : 'The connectors could not be read.'}
                <Action tone="outline" size="small" onClick={() => void failed.refetch()}>
                  Try again
                </Action>
              </div>
            ) : !ready ? (
              <SkeletonRegion label="Loading connector…">
                <SettingsGroup>
                  <SettingsRowsSkeleton count={4} />
                </SettingsGroup>
              </SkeletonRegion>
            ) : (
              !leaving && (
                <p className="text-sm text-muted">
                  No connector named <span className="text-ink">{id}</span>.
                </p>
              )
            )}
          </div>
        )}
      </PageBody>
    </div>
  );
}
