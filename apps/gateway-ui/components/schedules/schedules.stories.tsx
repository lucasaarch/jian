import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { useWorkspace } from '../../lib/workspace';
import { sectionProps } from '../../stories/section';
import { withWorkspace } from '../../stories/workspace';
import { Schedules } from '.';

const meta = {
  title: 'Sections/Schedules',
  parameters: { layout: 'padded' },
  decorators: [withWorkspace],
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

/** On the workspace's data, so creating, editing and switching one off show as they would. */
function Live() {
  const { data, profile, mutate, api } = useWorkspace();

  return (
    <Schedules
      {...sectionProps({ ...(data ? { data } : {}), ...(profile ? { profile } : {}) })}
      api={api}
      mutate={mutate}
    />
  );
}

export const List: Story = { render: () => <Live /> };
