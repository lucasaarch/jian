import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { fn } from 'storybook/test';
import { withWorkspace } from '../../stories/workspace';
import { ProfileSwitcher } from './profile-switcher';
import { Sidebar } from './sidebar';
import { AccentPicker, ModePicker } from './theme-picker';
import { Topbar } from './topbar';

const meta = {
  title: 'Shell',
  decorators: [withWorkspace],
  parameters: {
    layout: 'fullscreen',
    nextjs: { appDirectory: true, navigation: { pathname: '/sessions' } },
  },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Navigation: Story = {
  render: () => (
    <div className="app-shell">
      <Sidebar open onNavigate={fn()} onCreateProfile={fn()} />
    </div>
  ),
};

export const TopBar: Story = {
  render: () => <Topbar onOpenNavigation={fn()} navigationOpen={false} />,
};

export const ProfileSelector: Story = {
  parameters: { layout: 'padded' },
  render: () => <ProfileSwitcher onCreate={fn()} />,
};

/** Light, dark or the system's; the toolbar above switches the whole canvas too. */
export const Mode: Story = {
  parameters: { layout: 'padded' },
  render: () => <ModePicker />,
};

/** The five accents, each drawn in the active mode. */
export const Accent: Story = {
  parameters: { layout: 'padded' },
  render: () => <AccentPicker />,
};
