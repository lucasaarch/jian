import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { useWorkspace, WorkspaceProvider } from '../../lib/workspace';
import { ids, profiles } from '../../stories/fixtures';
import { sectionProps } from '../../stories/section';
import { ThemeProvider } from '../shell/theme';
import { Campaigns } from '.';

const attendant = profiles.filter((profile) => profile.id === ids.ichigo);

const meta = {
  title: 'Professions/Sales Attendant/Campaigns',
  parameters: { layout: 'padded' },
  decorators: [
    (Story) => (
      <ThemeProvider>
        <WorkspaceProvider initialProfiles={attendant} onSignOut={() => {}}>
          <Story />
        </WorkspaceProvider>
      </ThemeProvider>
    ),
  ],
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

function Live() {
  const { data, profile, mutate, api } = useWorkspace();

  return (
    <Campaigns
      {...sectionProps({ ...(data ? { data } : {}), ...(profile ? { profile } : {}) })}
      api={api}
      mutate={mutate}
    />
  );
}

export const List: Story = { render: () => <Live /> };
