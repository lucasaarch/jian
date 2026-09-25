import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import type { ComponentType } from 'react';
import ChannelsPage from '../../app/(workspace)/channels/page';
import ConversationsPage from '../../app/(workspace)/conversations/page';
import IdentityPage from '../../app/(workspace)/identity/page';
import WorkspaceLayout from '../../app/(workspace)/layout';
import McpPage from '../../app/(workspace)/mcp/page';
import MemoriesPage from '../../app/(workspace)/memories/page';
import ModelsPage from '../../app/(workspace)/models/page';
import OverviewPage from '../../app/(workspace)/page';
import ProvidersPage from '../../app/(workspace)/providers/page';
import SessionsPage from '../../app/(workspace)/sessions/page';
import AccessibilityPage from '../../app/(workspace)/settings/accessibility/page';
import AppearancePage from '../../app/(workspace)/settings/appearance/page';
import SkillsPage from '../../app/(workspace)/skills/page';
import StickersPage from '../../app/(workspace)/stickers/page';
import { emptyHandlers, updatedHandlers } from '../handlers';

/**
 * Every screen of the panel as it really renders: the workspace layout, the sidebar, and the
 * page, loading an installation from the story's handlers. Nothing here talks to a gateway.
 */
const meta = {
  title: 'Pages/Workspace',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const page = (Page: ComponentType, pathname: string): Story => ({
  parameters: { nextjs: { appDirectory: true, navigation: { pathname } } },
  render: () => (
    <WorkspaceLayout>
      <Page />
    </WorkspaceLayout>
  ),
});

export const Overview = page(OverviewPage, '/');
export const Sessions = page(SessionsPage, '/sessions');
export const Conversations = page(ConversationsPage, '/conversations');
export const Identity = page(IdentityPage, '/identity');
export const Models = page(ModelsPage, '/models');
export const Providers = page(ProvidersPage, '/providers');
export const Channels = page(ChannelsPage, '/channels');
export const Memories = page(MemoriesPage, '/memories');
export const Stickers = page(StickersPage, '/stickers');
export const Skills = page(SkillsPage, '/skills');
export const Mcp = page(McpPage, '/mcp');
export const Appearance = page(AppearancePage, '/settings/appearance');
export const Accessibility = page(AccessibilityPage, '/settings/accessibility');

/** A gateway on its first day: no providers, no channels, no conversations. */
export const FirstRun: Story = {
  ...page(OverviewPage, '/'),
  parameters: {
    ...page(OverviewPage, '/').parameters,
    msw: { handlers: emptyHandlers },
  },
};

/** Right after an update: the release dialog opens over the page, once. */
export const AfterAnUpdate: Story = {
  ...page(OverviewPage, '/'),
  parameters: {
    ...page(OverviewPage, '/').parameters,
    msw: { handlers: updatedHandlers },
  },
};

/** On a phone: the sidebar folds into the menu button. */
export const Mobile: Story = {
  ...page(SessionsPage, '/sessions'),
  globals: { viewport: { value: 'mobile2', isRotated: false } },
};

/** The same screens on the dark canvas. */
export const OverviewDark: Story = { ...page(OverviewPage, '/'), globals: { mode: 'dark' } };
export const ChannelsDark: Story = {
  ...page(ChannelsPage, '/channels'),
  globals: { mode: 'dark' },
};
export const SessionsDark: Story = {
  ...page(SessionsPage, '/sessions'),
  globals: { mode: 'dark' },
};
export const AppearanceDark: Story = {
  ...page(AppearancePage, '/settings/appearance'),
  globals: { mode: 'dark' },
};
