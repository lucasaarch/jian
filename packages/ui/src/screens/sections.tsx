'use client';

import { Channels } from '../components/channels';
import { Integrations } from '../components/integrations';
import { GitHubApp } from '../components/integrations/github-app';
import { Memories } from '../components/memories';
import { Overview } from '../components/overview';
import { ProfileEditor } from '../components/profile/editor';
import { Providers } from '../components/providers';
import { ModelDefaults } from '../components/providers/model-defaults';
import { RemoteMachines } from '../components/remote';
import { Schedules } from '../components/schedules';
import { Skills } from '../components/skills';
import { SshKeys } from '../components/ssh-keys';
import { panelApi } from '../lib/query/client';
import { useActions } from '../lib/workspace';

/**
 * Every section of the panel as a screen of its own, its actions already in hand: a host maps
 * each of its routes to one, the web's pages and the native app's alike.
 */
export const OverviewScreen = () => <Overview api={panelApi()} />;
export const ChannelsScreen = () => <Channels {...useActions()} />;
export const IdentityScreen = () => <ProfileEditor {...useActions()} />;
export const MemoriesScreen = () => <Memories {...useActions()} />;
export const SchedulesScreen = () => <Schedules {...useActions()} />;
export const SkillsScreen = () => <Skills {...useActions()} />;
export const ProvidersScreen = () => <Providers {...useActions()} />;
export const ModelsScreen = () => <ModelDefaults {...useActions()} />;
export const AppsScreen = () => <Integrations tab="apps" />;
export const McpsScreen = () => <Integrations tab="mcps" />;
export const GitHubAppScreen = GitHubApp;
export const RemoteScreen = () => <RemoteMachines api={panelApi()} />;
export const SshKeysScreen = () => <SshKeys {...useActions()} />;
