import {
  AgentArea,
  AppsScreen,
  ChannelsScreen,
  GitHubAppScreen,
  Home,
  IdentityScreen,
  McpsScreen,
  MemoriesScreen,
  ModelsScreen,
  OverviewScreen,
  ProvidersScreen,
  RemoteScreen,
  SchedulesScreen,
  SessionsScreen,
  SettingsArea,
  SkillsScreen,
  SshKeysScreen,
  WorkspaceLayout,
} from '@jian/ui';
import type { ComponentType, ReactNode } from 'react';
import { Section } from './section';

/** The sections of an agent, by the path after /agents/<id>/: the web host's pages, one by one. */
const AGENT_SECTIONS: Record<string, ComponentType> = {
  channels: ChannelsScreen,
  identity: IdentityScreen,
  memories: MemoriesScreen,
  schedules: SchedulesScreen,
  skills: SkillsScreen,
};

const SETTINGS: Record<string, ComponentType> = {
  providers: ProvidersScreen,
  models: ModelsScreen,
  remote: RemoteScreen,
  'ssh-keys': SshKeysScreen,
  integrations: AppsScreen,
  'integrations/github': GitHubAppScreen,
  'integrations/mcps': McpsScreen,
};

/**
 * The panel at `pathname`, nested as the web host's layouts nest it. An address the panel has
 * no screen for opens the workspace's home, as the web host's not-found does.
 */
export function Screen({ pathname }: { pathname: string }): ReactNode {
  const agent = /^\/agents\/[^/]+(?:\/(.*))?$/.exec(pathname);
  if (agent) {
    const rest = agent[1] ?? '';
    const Section_ = AGENT_SECTIONS[rest];
    const content =
      rest === '' ? (
        <OverviewScreen />
      ) : /^sessions(\/[^/]+)?$/.test(rest) ? (
        // The sessions screen draws itself and reads the open conversation from the path.
        <SessionsScreen>{null}</SessionsScreen>
      ) : Section_ ? (
        <Section_ />
      ) : null;
    return (
      <WorkspaceLayout>
        <AgentArea>
          <Section key={pathname}>{content ?? <OverviewScreen />}</Section>
        </AgentArea>
      </WorkspaceLayout>
    );
  }

  const settings = /^\/settings(?:\/(.*))?$/.exec(pathname);
  if (settings) {
    const Settings = SETTINGS[settings[1] ?? ''] ?? ProvidersScreen;
    return (
      <WorkspaceLayout>
        <SettingsArea>
          <Section key={pathname}>
            <Settings />
          </Section>
        </SettingsArea>
      </WorkspaceLayout>
    );
  }

  return (
    <WorkspaceLayout>
      <Home />
    </WorkspaceLayout>
  );
}
